# F-012 · Read-through cache for the todo list endpoint

> Status is tracked in `specs/features.yaml`, not here.

## Problem

Every `GET /api/todos` is a Postgres query, including the many that ask the same
question the same client asked seconds ago. The web client fetches page one on every
page load and re-fetches it after every create, toggle, and delete
(`web/src/todos.ts`), so a user doing nothing but ticking boxes generates a steady
stream of identical `SELECT ... WHERE user_id = $1 AND deleted_at IS NULL ORDER BY
created_at DESC LIMIT 21` statements. The query is index-served and individually
cheap, which is exactly why nothing surfaces it today: the cost is not a slow request,
it is that the list endpoint's throughput is bounded by database connections
(`DATABASE_POOL_MAX`, 10) rather than by anything the application controls, and the
pool is shared with login, session loading, and the idempotency table. Under the load
profile `load/smoke.js` describes, the read path is the first thing that will contend
for a connection with the write paths that actually need one.

## Scope

**In scope**

- A read-through cache for `GET /api/todos` **when no `cursor` is supplied**, keyed by
  the caller's user id and by every query dimension that changes the result — including
  `deleted`, which F-010 added
- One Redis hash per user, invalidated **whole** on any successful write to that user's
  todos: create, update, delete, restore (ADR 0020)
- A `TODO_LIST_CACHE_ENABLED` switch and a `TODO_LIST_CACHE_TTL_SECONDS` knob, both
  gated behind the `REDIS_URL` that F-011 introduced and that is empty in every
  deployed environment (ADR 0018)
- Cache errors, timeouts, and an absent Redis all behaving as a miss — the request
  falls through to Postgres and the response is byte-identical to today's (ADR 0021)
- Re-validating a cached entry against the route's own zod response schema before
  serving it, and a `v1` format tag, so a stale or malformed entry is a miss
- One counter (`todo_list_cache_operations_total`), one boot log line, and an
  edge-triggered warn/info pair on the transition into and out of degraded mode
- Moving `withTimeout` and `hashIdentity` out of `src/lib/rate-limit-store.ts` into
  `src/lib/redis.ts` so both consumers share them, with no behaviour change
- `.env.example` and `docs/deployment-sevalla.md` updates describing both new keys and
  what an unset value means

**Out of scope**

- **Provisioning a Redis instance anywhere.** That decision was made in ADR 0018 and
  belongs to F-022. `REDIS_URL` is empty on merge day and this feature does not set it.
- **Caching any other endpoint.** `GET /api/todos/:id` is a single-row primary-key
  lookup and adding it would add a second invalidation surface for no measurable win.
  No auth, session, or health response is cached.
- **Caching paginated requests beyond the first page.** A request carrying `cursor` goes
  straight to Postgres; see ADR 0020 for why.
- **HTTP-level caching.** No `ETag`, no `Last-Modified`, no `Cache-Control`, no CDN, no
  `304`. The response headers are unchanged, so no client behaviour changes.
- **Surgical or per-page invalidation**, a version counter, a lock, a stampede guard, an
  invalidation retry queue, or an outbox. All rejected in ADR 0020 and ADR 0021.
- **A per-instance in-memory cache** when Redis is absent. Rejected in ADR 0021: unlike
  the rate limiter's local fallback, a per-instance cache is not weaker-but-correct, it
  is wrong.
- **Any database migration, route, schema, response body, status code, or OpenAPI
  change.** `openapi.json` is byte-identical after this feature.
- **Changing the query, the keyset ordering, or issue #29.** What is cached is exactly
  what the handler returns today.

## Design

### API changes

None. No new route, no changed status code, no changed response body, no new or changed
header, and therefore no `openapi.json` regeneration.

| Method | Path                     | Auth    | Notes                                                                                                                                          |
| ------ | ------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/todos`             | session | Unchanged contract. Served from Redis when a cursor-less variant is cached and fresh; otherwise from Postgres, exactly as today.               |
| POST   | `/api/todos`             | session | Unchanged. Additionally discards the caller's cached list on success.                                                                          |
| PATCH  | `/api/todos/:id`         | session | Unchanged. Additionally discards the caller's cached list on success.                                                                          |
| DELETE | `/api/todos/:id`         | session | Unchanged. Additionally discards the caller's cached list on success — this also covers the rows removed by the opportunistic retention sweep. |
| POST   | `/api/todos/:id/restore` | session | Unchanged. Additionally discards the caller's cached list on success, which covers both the live list and the trash view.                      |

A failed write (`404`, `400`, `409`) invalidates nothing, because it changed nothing.

### Configuration

Two new keys in `src/config.ts` and `.env.example`. No existing key changes meaning.

| Key                           | Type    | Default | Meaning                                                                                                                          |
| ----------------------------- | ------- | ------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `TODO_LIST_CACHE_ENABLED`     | boolish | `false` | Master switch. `false`, or a `false` with any `REDIS_URL`, means no cache object is constructed and the handler is today's code. |
| `TODO_LIST_CACHE_TTL_SECONDS` | number  | `30`    | Expiry on the per-user hash. A backstop for a failed invalidation, not the freshness mechanism — see ADR 0020.                   |

The cache is live only when `REDIS_URL` is non-empty **and**
`TODO_LIST_CACHE_ENABLED=true`. It reuses `REDIS_TIMEOUT_MS` (50 ms) as its per-command
budget rather than introducing a third timeout knob.

**Why a switch of its own rather than riding on `REDIS_URL`.** Because otherwise the
only lever for a misbehaving cache is unsetting `REDIS_URL`, which would also switch off
F-011's distributed rate limiting — trading a security control to fix a stale list is
not a rollback anyone should be offered at 2am. It also means F-022, whose subject is a
security control, cannot silently switch on a caching layer as a side effect.

**Boot rule, `loadConfig`, ADR 0007 shape — the process refuses to start in every
`NODE_ENV`:** `TODO_LIST_CACHE_ENABLED=true` with an empty `REDIS_URL`. That
configuration claims a capability that does not exist, and the failure it would
otherwise produce is silence. This is the same "set and wrong" rule `validateRedis`
already applies to a mistyped URL, and it is deliberately **not** a rule requiring the
cache in production — an absent cache removes nothing, for the reasons ADR 0018 gives
about an absent limiter and ADR 0021 gives about this one specifically.
`TODO_LIST_CACHE_TTL_SECONDS` outside `1..300` is a zod bound, like every other knob.

### Data model changes

**None in Postgres.** No migration, no column, no index, no backfill, so there is no
expand/contract plan to state and nothing in the database to undo on rollback. The
existing `todos_user_id_created_at_idx` keeps serving every list query, cached or not.

The only new state is a Redis keyspace, described in full because nothing else in the
repo will:

| Property     | Value                                                                                                                                                                      |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Key          | `c:todos:{hash}` — one **hash** per user. `c:` is the client `keyPrefix`, so it cannot collide with F-011's `rl:`.                                                         |
| `hash`       | `hashIdentity(COOKIE_SECRET, userId)` — the same keyed HMAC F-011 uses, so the keyspace is not a list of account ids.                                                      |
| Field        | `v1:{live\|trash}:{any\|done\|open}:{limit}` — every dimension of `ListQuery` except `cursor`. `live\|trash` is the `deleted` parameter; `any\|done\|open` is `completed`. |
| Value        | `JSON.stringify({ items, nextCursor })` — the handler's response body, unmodified.                                                                                         |
| TTL          | `PEXPIRE` on the whole key to `TODO_LIST_CACHE_TTL_SECONDS`, re-applied on every write-back. Nothing outlives it.                                                          |
| Invalidation | `DEL` on the key. One command, every variant, no enumeration (ADR 0020).                                                                                                   |
| Durability   | None required. `--appendonly no`; a flushed or restarted Redis is a cold cache, which is a correct cache.                                                                  |
| Growth bound | One key per active user, at most 16 fields (dropped wholesale beyond that), each ≤ `limit` todos. Expiry is the only eviction needed; `volatile-lru` is a belt.            |

The expand/contract analogue is that the format tag `v1` is the contract: a future change
to `TodoView` bumps it, old fields become unreachable and expire, and no deploy can serve
a previous release's shape. Turning the cache on is one variable, turning it off is
another, and neither direction reads or writes anything that has to be migrated.

### Files

| File                                        | Change                                                                                                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/todo-list-cache.ts`                | **new.** `createTodoListCache(redis, config, log)` → `{ get, set, invalidate }`. All Redis contact, all error swallowing, ~120 lines.                   |
| `src/routes/todos.ts`                       | An optional cache parameter; the list handler consults it, the four write handlers call `invalidate` after a successful commit. ~40 lines.              |
| `src/lib/redis.ts`                          | Receives `withTimeout` and `hashIdentity`, moved verbatim from `rate-limit-store.ts`. No behaviour change.                                              |
| `src/lib/rate-limit-store.ts`               | Imports those two from `redis.ts` instead of defining them. Import lines only.                                                                          |
| `src/app.ts`                                | A second `createRedis(config, { keyPrefix: 'c:' })` when the cache is enabled, its `onClose`, and passing the cache to `registerTodoRoutes`. ~15 lines. |
| `src/plugins/metrics.ts`                    | Registers `todoListCacheOperations` and adds the boot log line, beside the existing `rate limiter ready` line. ~10 lines.                               |
| `src/config.ts`                             | The two keys and the one boot rule.                                                                                                                     |
| `.env.example`                              | Both keys, with the comment explaining what disabled means.                                                                                             |
| `docker-compose.yml`                        | Unchanged — F-011 already added the `redis` service.                                                                                                    |
| `tests/unit/todo-list-cache.test.ts`        | **new.**                                                                                                                                                |
| `tests/integration/todo-list-cache.test.ts` | **new**, against the throwaway Redis `global-setup.ts` already starts.                                                                                  |
| `docs/deployment-sevalla.md`                | Both keys in the environment table, and the note that the cache is off.                                                                                 |

No workflow file, no `Dockerfile`, no `package-lock.json`, no `drizzle/`, no
`openapi.json`, and no `src/db/schema.ts` change. **No new dependency of any kind** —
`ioredis` and `prom-client` are already installed.

### How a request is served

`src/lib/todo-list-cache.ts` owns every line that touches Redis; `src/routes/todos.ts`
never sees a Redis error, a timeout, or a serialisation concern.

**Read (`GET /api/todos`).**

1. If the cache is not configured, or `request.query.cursor` is present, go to Postgres.
   Nothing else happens — this is today's handler.
2. `HGET c:todos:{hash} {field}`, bounded by `REDIS_TIMEOUT_MS`.
3. On a value, `JSON.parse` it and run it through the route's own response schema
   (`z.object({ items: z.array(TodoView), nextCursor: ... })`). A parse or validation
   failure is counted as `outcome="invalid"` and treated as a **miss**, never as an
   error and never served. On success: `{operation:"get", outcome:"hit"}`, return it.
4. On nil, error, or timeout: `{operation:"get", outcome:"miss"|"error"}`, run the
   existing query unchanged.
5. Write back with one round trip and then return. The write-back is **awaited** under
   the same timeout, not fired and forgotten: a floating promise is a lint failure in
   this repo, and an error that lands after the response has no request to be attributed
   to. Worst case it adds `REDIS_TIMEOUT_MS` to a path that has already paid for a
   Postgres query.

The write-back is one `defineCommand` Lua script, matching how `rate-limit-store.ts`
already talks to Redis, because the field cap wants to be atomic with the write:

```lua
if redis.call('HLEN', KEYS[1]) >= tonumber(ARGV[3]) then redis.call('DEL', KEYS[1]) end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[4]))
```

The field name and the body are `ARGV`, never concatenated into the script.

**Write (`POST`, `PATCH`, `DELETE`, `POST /:id/restore`).** After the statement has
committed and the handler has decided it succeeded — after the `404` checks, before the
response is sent — `await cache.invalidate(userId)`, which issues `DEL` under the same
timeout and **cannot throw**. A failure counts `{operation:"invalidate",
outcome:"error"}`, logs once per transition, and lets the response proceed: the row is
already committed in Postgres, and turning a successful write into a `5xx` would make
the client retry something that already happened.

**Invalidation is an explicit call in each handler, not an `onResponse` hook.** The hook
version is DRY and cannot be forgotten, and it was rejected for the reason ADR 0016 gives
about soft-delete predicates: a reviewer reading one handler should be able to see what
it does to the cache, without knowing a hook exists. The cost is that a future write
handler can forget, so there is one integration case per mutating route and a comment at
the top of the route file naming the obligation.

**`src/app.ts`** changes shape only when both switches are on:

```
const cacheRedis =
  config.TODO_LIST_CACHE_ENABLED && config.REDIS_URL
    ? createRedis(config, { keyPrefix: 'c:', log: app.log })
    : null;
const todoListCache = cacheRedis ? createTodoListCache(cacheRedis, config, app.log) : null;
registerTodoRoutes(app, db, idempotency, metrics, todoListCache);
```

with the same `onClose` quit/disconnect pair F-011 uses. With either switch off,
`todoListCache` is `null`, every call site short-circuits on it, and the executed path is
byte-for-byte today's.

**A second client, not the limiter's.** `createRedis`'s `keyPrefix` is per-client and its
own doc comment anticipates this ("`rl:` for the rate limiter, something else for the
cache that comes next"). Sharing one client would mean either rewriting
`rate-limit-store.ts` to prefix its own keys — changing F-011's keyspace and the test that
asserts it — or living under `rl:`. It also keeps a cache command out of the socket the
rate limiter's commands queue on, which matters because the limiter is a security control
on the hot path and ioredis multiplexes one connection. The cost is one extra TCP
connection per instance.

### Key decisions

Two ADRs: **`docs/adr/0020-a-cache-invalidates-a-user-not-a-page.md`** (what is cached and
how it is discarded) and **`docs/adr/0021-an-unreachable-cache-is-a-cache-miss.md`** (what
happens when Redis cannot answer).

**This feature inherits ADR 0018 rather than re-opening it, and F-012's deps stay
`[F-011]`.** The provisioning question was decided for the whole project when F-011
shipped: `REDIS_URL` is empty everywhere, a capability selected by it ships anyway, and
buying a store is F-022's job. The F-011 planner explicitly left it to a human whether
F-012 should depend on F-022. **The recommendation here is no**, for three reasons. The
implementation is fully provable without a provisioned instance — the integration suite
already starts a throwaway Redis, and correctness of invalidation is exactly the kind of
thing a container proves better than production does. Blocking planning and
implementation on a purchase serialises work for no engineering benefit, which is the
argument F-008/F-019 and F-011/F-022 have already accepted twice. And the cache has one
property the limiter does not: an absent cache is not even a degraded state, it is the
current, correct, tested behaviour of the endpoint. **If you disagree, this is one of
the two lines to reject the spec on** — the other is the invalidation granularity below.

**Honest consequence, stated the way ADR 0018 requires: this feature does nothing in
production on the day it merges, and unlike F-011 it will still do nothing on the day
F-022 lands**, because `TODO_LIST_CACHE_ENABLED` defaults to `false`. That is the fifth
dark feature in this project's history and the second one that is dark twice over. The
rollout section names the exact steps and the exact metric that turns it on, so the
remainder left to a human is an operational flip with a watch list, not an unspecified
intention.

**Any write discards the whole user, and nothing tries to be surgical.** Argued in ADR 0020. The short version: since F-010, one write can move a row between the live list and
the trash, between `completed` filters, and — on restore — back into the _middle_ of the
keyset at its original `created_at`, so per-page invalidation would need five rules that
fail silently rather than loudly when wrong. This is the decision that trades hit rate
for correctness, and it is the one most worth arguing with.

**Only cursor-less requests are cached.** Cursors are `created_at` values: opaque to the
client, high-cardinality, and requested least often. Caching them would multiply the
keyspace by the user's row count to buy hit rate on page seven.

**The `deleted` dimension is part of the field name.** ADR 0016 named this exact bug in
advance — "a cache key that does not include the deleted filter will serve the trash to
the live view" — so it gets its own acceptance criterion rather than a footnote.

**A cache failure is a miss; there is no local fallback.** Argued in ADR 0021. ADR 0019's
generalisation asks every new request-path dependency to name its failure behaviour; the
answer differs from the limiter's because a limiter can count in the wrong place and
still be a limiter, whereas a cache that answers from the wrong place is just wrong. A
per-instance fallback would have made merge day less dark and would have shipped a bug:
a delete on instance A cannot clear instance B's copy, so the second tab gets the deleted
todo back for a full TTL.

**Cached entries are re-validated against the response schema before being served.** Two
things for one cheap line: an entry written by a previous release, or one that has been
tampered with, is a miss rather than a malformed `200`; and the handler never returns a
shape the OpenAPI contract does not describe. The `v1` field prefix is the coarse version
of the same guard.

**The user id is hashed, and that does not make the entry non-sensitive.** The key uses
F-011's `hashIdentity`, so the keyspace is not an enumerable list of account ids. Being
precise about what that does and does not buy: the **value** is the user's own todo
titles in clear, which is user content, and this is the first time any of it lives
outside Postgres. That is why `pii` is added to this feature's risk tags. It is judged
acceptable because Redis is the same internal trust boundary as Postgres, holds the
content for at most 30 seconds with no persistence, and is reached only by this
application — not because a hash made it safe. The security section carries the rest.

### Backlog split

**None, and the diff budget below is why.** At roughly 450 lines this fits inside the ~500
guidance without cutting. Nothing in scope is separable in the way F-011's provisioning
was: the enablement step here is one environment variable with a watch list, which is a
rollout instruction rather than a feature, so it is written into "Rollout" instead of
becoming F-023.

## Acceptance criteria

- [ ] With `TODO_LIST_CACHE_ENABLED=false` (the default), no cache client is constructed,
      `GET /api/todos` behaves exactly as today, and the existing `todos.test.ts` passes
      untouched — `integration: no cache client is built when the cache is disabled`
- [ ] With the cache on, two identical cursor-less `GET /api/todos` requests produce
      **one** Postgres query for the list, proven by a query counter on the pool, and
      identical response bodies — `integration: a repeated list is served from the cache`
- [ ] The cached response is byte-identical to the uncached one for the same state,
      compared field by field including `nextCursor` and every `TodoView` date —
      `integration: a cache hit matches the database answer exactly`
- [ ] `?deleted=true` and the default live list never share an entry: with the trash view
      cached, the live list still returns only live rows and vice versa —
      `integration: the trash view and the live list are separate entries`
- [ ] `?completed=true`, `?completed=false`, no `completed`, and a different `limit` are
      four separate entries; none serves another's result —
      `integration: every query dimension is part of the key`
- [ ] A request with a `cursor` is never served from, and never written to, the cache —
      `integration: paginated requests bypass the cache`
- [ ] Each of `POST /api/todos`, `PATCH /api/todos/:id`, `DELETE /api/todos/:id`, and
      `POST /api/todos/:id/restore` makes the next list request a miss that reflects the
      write — four cases, `integration: every write invalidates the caller's list`
- [ ] **Restore is visible in both views after invalidation**: with both the live list and
      the trash cached, restoring a todo makes it appear in the live list at its original
      `created_at` position and disappear from the trash, with no second write —
      `integration: restore invalidates both views`
- [ ] A failed write invalidates nothing: a `PATCH` returning `404` for another user's
      todo leaves the cached entry in place — `integration: a failed write does not invalidate`
- [ ] User A's write does not invalidate user B's entry, and no request ever receives
      another user's page — `integration: invalidation is scoped to one user` and
      `unit: keys differ per user and per COOKIE_SECRET`
- [ ] No Redis key contains a raw user id; keys present after a cached list match
      `c:todos:*` and carry the HMAC — `integration: cache keys carry no raw identity`
- [ ] With Redis stopped mid-run, `GET /api/todos` still returns `200` with correct data,
      writes still return their normal status, and no request returns a `5xx` —
      `integration: an unreachable cache is a miss, not an error`
- [ ] A request during that outage completes within `REDIS_TIMEOUT_MS + 50 ms` —
      `integration: a timing-out cache does not stall the request`
- [ ] The degrade transition logs exactly **one** `warn` for a burst of requests and
      recovery logs exactly one `info` — `unit: degrade and recover are edge-triggered`
- [ ] An entry whose JSON does not parse, and one that parses but fails the response
      schema, are both treated as a miss and counted `outcome="invalid"` — never served,
      never a `5xx` — `unit: a malformed entry is a miss`
- [ ] The per-user hash never exceeds 16 fields: writing 20 distinct `limit` variants
      leaves `HLEN` ≤ 16 and every surviving entry still valid —
      `integration: the hash is bounded`
- [ ] The TTL is applied: with `TODO_LIST_CACHE_TTL_SECONDS=1`, `PTTL` on the key is
      positive and ≤ 1000 ms after a write-back — `integration: entries expire`
- [ ] `todo_list_cache_operations_total{operation="get",outcome="hit"|"miss"}` and
      `{operation="invalidate",outcome="ok"}` advance as expected and are readable from
      `/metrics` — `integration: the cache counter reflects what happened`
- [ ] `loadConfig` throws for `TODO_LIST_CACHE_ENABLED=true` with an empty `REDIS_URL`,
      and for `TODO_LIST_CACHE_TTL_SECONDS=0` and `=301`; it accepts the defaults under
      `NODE_ENV=production` — `unit: config.test.ts`, one case each
- [ ] Neither the Redis URL nor any todo title appears in a log line at any level,
      including the degrade path — `integration: the cache logs no content and no url`
- [ ] The boot log line states whether the cache is live —
      `{ todoListCache: 'redis' | 'off', ttlSeconds }` — `integration: boot reports the cache`
- [ ] `app.close()` disconnects the cache client; the integration suite finishes with no
      open handle — `integration: the cache client is closed with the app`
- [ ] `make ci` passes with no new environment variable set anywhere in CI, and
      `openapi.json` is unchanged

## Test plan

| Layer       | Cases                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unit        | `tests/unit/todo-list-cache.test.ts` against a fake client: the field name includes `deleted`, `completed`, `limit`, and the `v1` tag, and differs for every combination · the key is stable, keyed, contains no raw user id, and changes with `COOKIE_SECRET` · a rejecting client makes `get` return undefined, `set` a no-op, and `invalidate` resolve — none of them throw · a timing-out client is abandoned at `REDIS_TIMEOUT_MS` · malformed JSON and schema-invalid JSON are misses counted `invalid` · degrade and recover log exactly once per transition · counter labels. `tests/unit/config.test.ts`: the boot rule and the TTL bounds, accept and reject.                                                                                                                                                                                                                               |
| integration | `tests/integration/todo-list-cache.test.ts`, against the real Redis `global-setup.ts` already starts (`TEST_REDIS_URL`), with a query counter wrapped around the pool to prove hits: **happy path** (second list is a hit, no query) · **validation failure** (`?limit=0` is a `400` and touches the cache on neither path) · **unauthenticated** (no session → `401`, no key created, since the cache is consulted after `requireAuth`) · **other user's resource** (A's entry survives B's writes; B never receives A's page) · every dimension separate, `deleted` first · cursor bypass · one invalidation case per mutating route · restore across both views · failed write does not invalidate · outage via `container.stop()`: `200`s, no `5xx`, bounded latency, counter labels, one warn, recovery · `KEYS c:*` inspected for raw ids · `HLEN` bound · `PTTL` · client closed with the app. |
| e2e         | None, deliberately, and this is the one uncomfortable gap. There is no browser surface and no user-visible change when the cache is working; when it is misbehaving the symptom is entirely user-visible, but Playwright runs against `STAGING_URL`, where `REDIS_URL` is empty and the cache is off by construction, so an e2e case would prove only that the disabled path works — which `make e2e` already proves. The staleness cases that matter are concurrency cases between two clients, which the integration suite can construct deterministically and a browser cannot.                                                                                                                                                                                                                                                                                                                    |
| load        | `k6 run load/smoke.js` three times against a local server: cache off, cache on cold, cache on warm. Recorded in the PR body with the hit ratio from `/metrics`, not a CI gate — the load job has no Redis and this feature does not add one. Expectations to state as numbers: the existing `p(95)<300ms` threshold holds in all three runs; the warm run shows a lower p95 on `GET /api/todos` and a lower query count; the cold run's p95 is no more than 10 % worse than cache-off, which is the bounded cost of the miss path. A warm run that is not faster means the feature is not worth enabling and the rollout should stop.                                                                                                                                                                                                                                                                 |

## Security considerations

**The new fact is that user content now lives outside Postgres.** Everything else in this
feature is a performance change; this is the part that deserves the scrutiny.

- **What is stored.** Todo titles, ids, timestamps, and completion state — the user's own
  rows, the same bytes the response already carries. No email address, no password hash,
  no session token, no reset or verification token, no IP address. Nothing from `users`,
  `sessions`, `password_reset_tokens`, or `idempotency_keys` is ever cached.
- **For how long.** At most `TODO_LIST_CACHE_TTL_SECONDS` (30), with no persistence
  configured, so an operator dump of Redis contains at most the last 30 seconds of
  actively-listed content. Postgres holds the same content durably, which is why this is
  judged an acceptable expansion of the surface rather than a new class of exposure — but
  it is an expansion, from one datastore holding user content to two, and it is flagged in
  the issue rather than buried here.
- **Who can read it.** Only this application, over Sevalla's internal network, with the
  credential in `REDIS_URL`. No TLS is required for a `redis://` URL, deliberately and
  symmetrically with `DATABASE_URL` and with F-011's identical reasoning; `rediss://` is
  accepted for the day the connection is not internal.
- **Cross-user leakage is the worst plausible bug in this feature**, and it is bounded by
  construction: the key is derived from `request.user!.id`, which is set by the session
  loader before the handler runs, and there is no path by which a field is read with one
  user id and written under another. It is asserted directly rather than argued
  (`invalidation is scoped to one user`, `keys differ per user`), because an argument is
  not a test.
- **Key enumeration.** Keys are `c:todos:{HMAC-SHA256(COOKIE_SECRET, userId)}`, so an
  operator or an attacker with `KEYS` access sees neither account ids nor a way to
  correlate an entry with a user without the secret. Honest limit: the **value** is still
  plaintext content, so this bounds correlation, not disclosure.
- **Memory as an attack surface.** A user can mint at most 600 field variants (`limit`
  1..100 × `completed` 3 × `deleted` 2) and the store caps a hash at 16, dropping it
  wholesale beyond that — the same bound, for the same reason, as the rate limiter's
  fallback map. Every key carries a TTL, so an attacker who stops attacking leaves nothing
  behind. Redis-side `maxmemory-policy volatile-lru` remains F-022's belt.
- **Cache poisoning.** Nothing but this application writes these keys, and an entry that
  does not parse against the response schema is discarded rather than served — so a
  corrupted or tampered value degrades to a database read rather than to a malformed
  response or an injected row.
- **Denial of service via Redis.** Taking Redis down removes an optimisation and nothing
  else; there is no control behind the cache and no fail-closed path (ADR 0021). This is
  strictly weaker than the equivalent attack on F-011, which at least costs a limiter
  multiplier.
- **Logging.** No title, no id, no user id, and no URL on any cache log line. The degrade
  and recover lines carry `{ host, port }` only, exactly as `redis.ts` already does.
- **Auth, sessions, migrations.** Untouched. `src/plugins/auth.ts`, `src/routes/auth.ts`,
  `src/lib/session.ts`, `src/lib/password.ts`, `src/db/schema.ts`, and `drizzle/` have no
  changes in this feature, and the list handler still runs behind `requireAuth` with the
  cache consulted only after it.
- **An obligation handed forward.** F-015 (account deletion) must invalidate, or a deleted
  account's list can be served from cache for up to the TTL after the rows are gone. Noted
  in ADR 0020 and here, because a GDPR deletion that is 30 seconds late is a different
  conversation than a stale todo.

## Observability

- **`todo_list_cache_operations_total{operation,outcome}`** — a prom-client counter on the
  existing custom registry. `operation` ∈ `get | set | invalidate`; `outcome` ∈
  `hit | miss | invalid | ok | error`. This one series answers every question the feature
  raises: the **hit ratio** (`hit / (hit + miss)`) says whether the cache is earning its
  keep, `{operation="invalidate",outcome="error"}` is the only counter in the system that
  can rise while users are being shown stale data and is therefore the page-worthy one,
  and `outcome="invalid"` rising after a deploy means a shape changed without the `v1` tag
  being bumped.
- **A low hit ratio is a real, expected reading**, not a broken metric: ADR 0020 trades hit
  rate for correctness, so a write-heavy account will hit near zero. The number is what
  makes that trade reviewable after the fact instead of a guess made in this document.
- **One boot log line**, beside `rate limiter ready`: `{ todoListCache: 'redis' | 'off',
ttlSeconds }`. Never the URL. This is what makes "is it on right now" answerable from
  logs, as ADR 0007 requires, and it is the first thing to check after the rollout flip.
- **An edge-triggered `warn` on degrade and `info` on recovery**, carrying `{ host, port }`
  — once per transition, never per request.
- **`http_request_duration_seconds{route="/api/todos",method="GET"}` is the latency
  signal** and already exists; no second histogram. The expected shape after enablement is
  a lower p95 with an unchanged error rate. An unchanged p95 means the cache is not being
  hit and the boot line or the hit ratio will say which.
- **Not measured here:** Redis memory, keyspace size, eviction count, and connection count.
  That is the datastore's own dashboard and it belongs with the instance, in F-022.

## Rollout

**Ships inert twice over.** `REDIS_URL` is empty in every deployed environment and
`TODO_LIST_CACHE_ENABLED` defaults to `false`, so on merge day no cache client is
constructed, `todoListCache` is `null`, every call site short-circuits, and the executed
path through `src/routes/todos.ts` is byte-for-byte today's. No environment variable is
required anywhere, so nothing here can fail a deploy for want of a value.

**Order.**

1. Merge. No migration, no config precondition, no `openapi.json` change, no workflow
   change, no dependency change.
2. Confirm on staging that the boot line reads `{ todoListCache: 'off' }`. Anything else
   means a variable was set somewhere unexpected.
3. **After F-022 has provisioned Redis and the limiter has been watched**, set
   `TODO_LIST_CACHE_ENABLED=true` on staging **only**, and leave production alone. Watch
   for at least an hour: the boot line flips to `redis`, the hit ratio climbs above zero,
   `{operation="invalidate",outcome="error"}` stays flat, and
   `http_request_duration_seconds{route="/api/todos"}` p95 falls. Then exercise the
   manual case no automated suite covers — delete a todo in one browser tab and list it
   in another — because the failure this feature can cause is a user seeing their own
   stale data, and one human doing that once is worth more than any assertion here.
4. Production, same flip, same watch list, on a different day.

**Rollback at 2am.** Set `TODO_LIST_CACHE_ENABLED=false` and restart. The code path is
gone rather than flagged off, every leftover key expires within the TTL without anybody
deleting it, and — the reason this switch exists separately — **F-011's distributed rate
limiting keeps running**. If a restart is not available, `FLUSHDB` on the cache keyspace
buys one TTL of correctness but does not stop the next write-back; the switch is the real
fix. There is no state to reconcile in either direction and no migration to reverse.

**The failure to watch for is staleness, not errors.** A cache that is erroring shows up
in the counter immediately; a cache that is silently serving a deleted todo shows up as a
support message. `{operation="invalidate",outcome="error"}` is the leading indicator, and
it is the one to alert on after F-019 gives this project somewhere to alert from.

**Diff budget.** ~450 hand-written lines: `src/lib/todo-list-cache.ts` (~120),
`src/routes/todos.ts` (~40), `src/config.ts` and `.env.example` (~30), `src/app.ts`,
`src/plugins/metrics.ts`, and the `redis.ts` helper move (~40), unit tests (~100),
integration tests (~120). Inside the ~500 guidance. **Cut order if it runs over:** first
the `TODO_LIST_CACHE_TTL_SECONDS` knob, hardcoded to 30; second the recovery `info` line,
keeping the degrade `warn`; third the 16-field hash cap, accepting the 600-field bound
that validation already gives. Never the `deleted` dimension in the field name, the
whole-user invalidation, the schema re-validation, or the outage test — those four are the
feature.
