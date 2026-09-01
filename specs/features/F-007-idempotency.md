# F-007 · Idempotency keys for unsafe requests

> Status is tracked in `specs/features.yaml`, not here.

## Problem

A client that sends `POST /api/todos` and never sees the response — mobile
network drop, proxy timeout, browser retry, user double-click — has no safe
option. Retrying may create a second identical todo; not retrying may lose the
todo entirely. The user ends up with duplicates they have to clean up by hand,
and there is no way for a client to ask "did my earlier attempt land?".

## Scope

**In scope**

- An optional `Idempotency-Key` request header on `POST /api/todos`
- Server-side record of the first outcome per `(user, key)`, and replay of the
  stored `201` response for a repeat of the same request
- Rejecting the same key reused for a different request body
- Rejecting a duplicate that arrives while the first attempt is still running
- Expiry and cleanup of stored idempotency records

**Out of scope**

- Idempotency on `POST /api/auth/*`. Registration and login create sessions;
  keeping this feature entirely out of the auth path is deliberate.
- `PATCH` and `DELETE /api/todos/:id`. They are already idempotent by resource
  id — repeating them converges on the same state.
- Making the header **required**. Existing clients must keep working unchanged.
- Blocking/long-polling a duplicate until the first attempt finishes. A
  duplicate in flight gets `409` and retries.
- A background reaper process, cross-instance locking, or Redis. See
  "Key decisions".
- Idempotency for any future endpoint. When one is added, it opts in.

## Design

### API changes

| Method | Path         | Auth    | Notes                                                                                                                                            |
| ------ | ------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| POST   | `/api/todos` | session | New **optional** request header `Idempotency-Key`: 16–255 chars matching `^[A-Za-z0-9_-]+$`. Absent → today's behaviour exactly, nothing stored. |

Behaviour of `POST /api/todos` when the header is present:

| Situation                                                                  | Response                                                                         |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Key unused by this user                                                    | Handler runs. `201` + todo. Outcome stored.                                      |
| Key seen before, same request fingerprint, first attempt completed         | `201` + **byte-identical stored body**, plus header `Idempotency-Replayed: true` |
| Key seen before, **different** fingerprint                                 | `409 { code: "idempotency_key_reuse" }`, handler does not run                    |
| Key seen before, first attempt still in flight (within 60 s lease)         | `409 { code: "idempotency_in_progress" }` + `Retry-After: 1`                     |
| Key seen before, first attempt abandoned (lease expired) or record expired | Record is taken over; handler runs normally                                      |
| Header malformed (length/charset)                                          | `400 { code: "validation_failed" }`, handler does not run                        |
| Unauthenticated                                                            | `401`, nothing stored — `requireAuth` runs at `preValidation`, before this       |

Only `2xx` outcomes are stored. A `4xx` or `5xx` releases the key immediately, so
a client can fix its request or retry a transient failure with the same key.

An `Idempotency-Key` sent to any other route is ignored (not an error), matching
how unknown headers behave today.

Error bodies keep the existing shape: `{ error: { code, message }, requestId }`.
Both 409s are raised with `conflict(code, message)` from `src/lib/errors.ts`.
`409` gains a declared response schema on this route (AGENTS.md: declare a schema
for every status code you return), so it appears in `openapi.json`. That schema
must serialise the exact global error body or the serializer turns it into a 500 —
there is an integration test for precisely that.

### Data model changes

New table, one migration, **purely additive**. Nothing is renamed, dropped, or
backfilled, so there is no contract step: expand is the whole plan.

`drizzle/0002_idempotency_keys.sql`:

```
idempotency_keys
  user_id         uuid        not null references users(id) on delete cascade
  key             text        not null
  fingerprint     text        not null   -- sha256 of method + route + canonical body
  status          text        not null   -- check in ('in_progress','completed')
  response_status integer                -- null while in_progress
  response_body   jsonb                  -- null while in_progress
  created_at      timestamptz not null default now()
  expires_at      timestamptz not null
  PRIMARY KEY (user_id, key)
```

Mirrored in `src/db/schema.ts`. `tests/integration/helpers.ts` adds the table to
the `TRUNCATE` list in `resetDb`.

**No `CREATE INDEX` statement, deliberately.** Both access paths are served by
the composite primary key:

- lookup / insert: `WHERE user_id = $1 AND key = $2` — full PK
- retention sweep: `DELETE WHERE user_id = $1 AND expires_at < now()` — PK
  leading-column scan over one user's handful of rows

This also avoids a live trap in the repo: `scripts/ci/migration-safety.mjs`
requires every new `CREATE INDEX` to be `CONCURRENTLY`, but `src/db/migrate.ts`
runs each migration file inside `BEGIN`/`COMMIT`, and Postgres refuses
`CREATE INDEX CONCURRENTLY` inside a transaction block. Any migration that adds
an index today passes CI and then fails at deploy. F-007 does not need an index,
so it does not resolve that conflict — flagged in the issue as separate work,
because fixing the runner is not this feature's job.

**Rollback:** the previous image ignores an unknown table. The migration can stay
applied through a rollback; drop it later in its own PR if the feature is
abandoned.

### Algorithm

`preHandler` (after `requireAuth`, after body validation, so the parsed body is
available for the fingerprint):

1. No `Idempotency-Key` header → do nothing, hand off to the handler.
2. Validate the header. Malformed → `400`.
3. `fingerprint = sha256(method + "\n" + routeUrl + "\n" + canonicalJson(body))`,
   where `canonicalJson` sorts object keys so `{a,b}` and `{b,a}` match.
4. Claim the key in one statement:

   ```sql
   INSERT INTO idempotency_keys (user_id, key, fingerprint, status, expires_at)
   VALUES ($1, $2, $3, 'in_progress', now() + $ttl)
   ON CONFLICT (user_id, key) DO UPDATE
     SET fingerprint = EXCLUDED.fingerprint,
         status      = 'in_progress',
         response_status = NULL,
         response_body   = NULL,
         created_at  = now(),
         expires_at  = EXCLUDED.expires_at
     WHERE idempotency_keys.expires_at < now()
        OR (idempotency_keys.status = 'in_progress'
            AND idempotency_keys.created_at < now() - interval '60 seconds')
   RETURNING key;
   ```

   A returned row means the request owns the key (fresh insert, expired record,
   or abandoned attempt taken over). This is a single autocommitted statement, so
   the claim is visible to a concurrent duplicate immediately.

5. No row returned → `SELECT` the existing record and branch: fingerprint
   mismatch → `409 idempotency_key_reuse`; `status = 'in_progress'` →
   `409 idempotency_in_progress`; `status = 'completed'` → reply immediately with
   the stored status and body plus `Idempotency-Replayed: true`.
6. Owning the key, opportunistically sweep this user's expired records
   (`DELETE ... WHERE user_id = $1 AND expires_at < now()`) and mark the request
   so the `onSend` hook knows to finalise it.

`onSend` (registered once globally, no-ops unless the request claimed a key):

- `2xx` → `UPDATE ... SET status='completed', response_status, response_body`
- otherwise → `DELETE` the record, releasing the key
- a failure of either write is logged at `error` and never changes the response;
  the record then expires or is taken over after the lease

### Key decisions

See **`docs/adr/0005-idempotency-keys.md`** for the full argument. Summary:

**Stored responses in Postgres, keyed per user.** Rejected: Redis `SETNX`
(F-011 has not landed; adding Redis for this alone contradicts ADR 0004's
"one datastore until measured otherwise"), and deduplicating on a body hash
alone (two genuinely different todos with the same title are a legitimate,
common request — the client must express intent explicitly).

**Key scoped to `(user_id, key)`, not globally unique.** A global key space lets
one user's key collide with another's, which is both a denial-of-service lever
and an information leak about other accounts' activity. Per-user scoping also
means a client can use a plain counter or a UUID without coordination.

**Fingerprint mismatch is `409`, not `422` or silent replay.** Silent replay
would return a todo the client never asked for — the worst outcome. The IETF
draft suggests `422`; this codebase already has a `conflict()` helper and no
`422`, and the condition genuinely is a conflict with stored state.

**409 for an in-flight duplicate, not waiting for the first attempt.** Waiting
means holding a request open on a shared connection pool while another request
runs, which turns one slow request into two. `Retry-After: 1` puts the retry
budget on the client, which already had one because it retried.

**60-second in-progress lease.** Without it, an instance that is killed mid-request
leaves the key poisoned for the full TTL. The lease is not a distributed lock and
does not claim to be: worst case, two attempts run and the second overwrites the
first's stored response — both created a todo, which is the pre-F-007 status quo,
not a regression.

**24-hour TTL (`IDEMPOTENCY_TTL_HOURS`, config, default 24), swept
opportunistically.** Rejected: a background reaper (a cron loop is process state
that has to be owned, monitored, and made safe across instances — for a table
this small it is not worth it) and unbounded retention (`users × requests-in-TTL`
grows without limit).

**Only `2xx` is stored.** Caching a `500` makes a transient failure permanent for
24 hours; caching a `400` stops a client from correcting its own request.

## Acceptance criteria

- [ ] `POST /api/todos` with a valid `Idempotency-Key` returns `201` and creates
      exactly one todo — `integration: creates a todo and stores the outcome`
- [ ] Repeating the identical request with the same key returns `201` with a body
      identical to the first response and `Idempotency-Replayed: true`, and
      `GET /api/todos` still shows exactly one todo —
      `integration: replays the stored response`
- [ ] The same key with a different body returns `409 idempotency_key_reuse` and
      creates no second todo — `integration: rejects a reused key with a different body`
- [ ] Two different users using the identical key value each get their own `201`
      and their own todo — `integration: idempotency keys are scoped per user`
- [ ] A request whose key has an `in_progress` record younger than the lease
      returns `409 idempotency_in_progress` with `Retry-After` —
      `integration: rejects a duplicate that is still in flight` (seeded via a
      direct insert; no timing race in the test)
- [ ] A request whose key has an `in_progress` record older than 60 s succeeds
      with `201` — `integration: takes over an abandoned attempt`
- [ ] A request whose key has a `completed` record past `expires_at` succeeds with
      `201` and creates a new todo — `integration: an expired key is reusable`
- [ ] `POST /api/todos` with **no** header behaves exactly as before and writes no
      `idempotency_keys` row — `integration: no key means no record`
- [ ] A key of 15 chars, 256 chars, or containing `/` returns `400
    validation_failed` and creates no todo — `integration: rejects a malformed key`
- [ ] An unauthenticated `POST` carrying a key returns `401` and writes no record —
      `integration: unauthenticated request with a key`
- [ ] A request that fails with `400` releases the key: an immediately following
      valid request with the same key returns `201` —
      `integration: a failed request does not consume the key`
- [ ] After a keyed request, that user's rows past `expires_at` are gone —
      `integration: sweeps this user's expired records`
- [ ] `canonicalJson` produces the same fingerprint for `{"a":1,"b":2}` and
      `{"b":2,"a":1}` and a different one for a different title —
      `unit: fingerprint is stable under key order`
- [ ] `/metrics` exposes `idempotency_requests_total` with an `outcome` label
      covering `stored`, `replayed`, `conflict`, `takeover` —
      `integration: exposes idempotency outcomes`
- [ ] `openapi.json` documents the `Idempotency-Key` header and the `409` response
      on `POST /api/todos` — `make ci` fails if the checked-in file is stale

## Test plan

| Layer       | Cases                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| unit        | `canonicalJson` key-order stability, nesting, and `undefined` handling · fingerprint differs when method, route, or body differ · key format schema accepts 16/255 chars and rejects 15/256/`/`/empty                                                                                                                                                                                                                                                                                                                                |
| integration | happy path (`201`, one todo, record stored) · replay returns identical body + `Idempotency-Replayed` · validation failure (malformed key → `400`) · unauthenticated (`401`, no record) · **other user's resource** (same key value, two users, no cross-visibility and no `409`) · reused key with different body → `409` · in-flight duplicate → `409` + `Retry-After` · abandoned lease takeover · expired record reuse · failed request releases the key · no header → no record · expired-record sweep · metrics counter present |
| e2e         | register → `POST` with a key → repeat the exact same request → list shows one todo (the network-retry journey, over real HTTP)                                                                                                                                                                                                                                                                                                                                                                                                       |
| load        | `load/smoke.js` gains a keyed create with a fresh key per iteration, tagged `endpoint:create_idem`, threshold `p(95)<300ms` — same budget as the unkeyed create. Two extra statements on the write path is the thing to watch; if this threshold fails, the sweep is the first suspect.                                                                                                                                                                                                                                              |

## Security considerations

**Cross-user probing.** The key space is partitioned by `user_id`, so a user can
never observe, collide with, or replay another user's record. The two 409s are
reachable only for keys the caller itself created; neither confirms anything
about another account. This is the same principle as returning 404 for another
user's todo.

**Stored response bodies.** A record holds a `201 TodoView` for its own owner —
a title the user just sent. No other user's data can enter the row, because the
row is written from that request's own response. Records are deleted by
`ON DELETE CASCADE` when the account is deleted (relevant to F-015).

**Storage exhaustion.** An authenticated user can create one row per keyed
request, bounded by `RATE_LIMIT_MAX` (100/min) × `IDEMPOTENCY_TTL_HOURS` — worst
case ~144k small rows per determined user per day, swept as they expire. The two
levers are the rate limit and the TTL, both config. No new rate limit is added:
keyed requests already count against the global one.

**Header injection / oversized headers.** The key is validated against
`^[A-Za-z0-9_-]+$` with a 255-char cap before touching the database, and is
parameterised in SQL. It is never interpolated into a log message, a response, or
an error string.

**Logging.** Log `outcome` and the route. **Never log the key itself** — it is
client-chosen, may embed a client-side identifier, and an operator holding a key
plus a session could probe for a stored response. Follows the existing rule
against logging tokens.

**Auth surface.** None. This feature deliberately does not touch
`src/plugins/auth.ts`, `src/routes/auth.ts`, or session handling; the hook runs
strictly after `requireAuth`.

## Observability

- `idempotency_requests_total{outcome="stored|replayed|conflict|takeover"}` — a
  new Prometheus counter in `src/plugins/metrics.ts`, passed into the plugin the
  same way `db` and `config` are passed to the route registrars. A steadily
  non-zero `replayed` proves the feature is actually catching retries in
  production; permanently zero means clients are not sending the header and the
  feature is decorative. Rising `conflict` means clients are reusing keys
  incorrectly. Any `takeover` at all means requests are dying mid-flight — that
  is the interesting alert.
- `http_request_duration_seconds{route="/api/todos",method="POST"}` already
  exists; the p95 before/after tells you what the extra statements cost.
- One structured log line per non-`stored` outcome: `request.log.info({ idempotency: { outcome } })`,
  plus `request.log.error` if finalising the record fails (the case where the
  response is correct but the record is left stale).

## Rollout

**No feature flag.** The behaviour is opt-in by construction: a client that does
not send the header gets byte-identical behaviour to today, which is also what
every existing client does. A flag would add a branch that is never exercised.

**Order.** One PR, one migration, purely additive; the migration is applied at
container start before the server boots (`scripts/docker-entrypoint.sh`), so the
table exists before any code reads it. Old instances during the rolling deploy
ignore both the table and the header.

**Rollback at 2am.** Redeploy the previous image. Nothing to undo: the table is
inert without the code, in-flight records simply expire, and no existing column
or behaviour was modified. If the feature misbehaves but a rollback is undesirable
(e.g. deploying is slow), setting `IDEMPOTENCY_TTL_HOURS` low shrinks the blast
radius but does not disable the code path — a rollback is the real off switch,
and that is by design.

**Diff budget.** Estimated ~450 hand-written lines across migration, schema,
`src/lib/idempotency.ts`, `src/plugins/idempotency.ts`, `routes/todos.ts`,
`app.ts`, config, metrics, and three test layers, plus a regenerated
`openapi.json` (generated, excluded from that count). Close to the 500-line
guidance; if the implementer finds it going well over, the load-test addition is
the piece to split into a follow-up, not any of the tests above.
