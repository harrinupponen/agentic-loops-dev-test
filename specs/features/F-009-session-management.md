# F-009 · Session management — list and revoke active sessions

> Status is tracked in `specs/features.yaml`, not here.

## Problem

A user who signs in on a library computer, a phone they later sell, or a laptop
that is then stolen has no way to see that the session still exists and no way to
end it. Today the only ways a session dies are the user clicking log out on that
exact device, the seven-day TTL expiring, or a full password reset silently
destroying every session at once (F-004). There is no answer to "am I still
signed in somewhere I should not be?", and the only remediation available is a
password reset — which requires mailbox access, changes a credential nobody asked
to change, and signs the user out everywhere including the device in their hand.

## Scope

**In scope**

- List the caller's own live sessions, with enough metadata to tell them apart
  and a flag marking the one making the request
- Revoke one named session
- Revoke every session except the one making the request ("sign out everywhere
  else")
- One additive migration giving a session a public identifier that is not
  derived from its token, plus the device string needed to recognise it

**Out of scope**

- **Browser screens.** F-006 put "log out everywhere (F-009)" out of scope and
  pointed here. This feature builds the API; **F-020**, added to the backlog by
  this plan, builds the screen and owns the browser journey. See "Backlog split".
- **Storing an IP address, a geolocation, or any derived location** — a separate
  decision with its own reasoning, recorded as rejected in ADR 0015 rather than
  deferred silently.
- **Parsing the user agent into "Chrome on macOS".** That is a dependency with a
  signature database and a rot schedule (AGENTS.md rule 7). The raw string is
  stored and returned; rendering is the screen's problem.
- **Naming or renaming a session** ("Harri's MacBook"). Nobody asked.
- A sweeper for expired session rows. They are already deleted lazily on access
  by the session loader, `sessions_expires_at_idx` already exists for whoever
  wants the job, and this feature does not need one to be correct.
- Any cap on how many sessions an account may hold, and any change to how a
  session is created, refreshed, or validated beyond writing two new columns.
- Step-up authentication (re-entering the password before revoking). See
  "Security considerations" for why, in this application, it buys nothing.
- Notifying the user by mail that a session was revoked. There is no transport
  until F-018.
- Recording the revocation as an audit event. That is F-014, which depends on
  this feature precisely so it has a stable session identifier to record.

## Design

### API changes

Three new endpoints, all authenticated, all in a new `src/routes/sessions.ts`
under the existing `auth` OpenAPI tag (so `src/app.ts`'s tag list is unchanged).
`src/routes/auth.ts` is already ~500 lines and CODEOWNERS-protected; a separate
file keeps this feature's surface reviewable on its own.

| Method | Path                     | Auth    | Notes                                                                                                                                  |
| ------ | ------------------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/auth/sessions`     | session | The caller's live sessions, newest first, capped at 100. `200 { items, truncated }`.                                                   |
| DELETE | `/api/auth/sessions/:id` | session | Revokes one session by **public id**. `204`. `404` if it is not the caller's. Clears the cookie if it is the caller's current session. |
| DELETE | `/api/auth/sessions`     | session | Revokes every session for the caller **except the current one**. `204`, always, even at zero rows.                                     |

`SessionView`, the only representation:

```ts
{
  id: string; // uuid — sessions.public_id, NOT the token hash
  createdAt: Date;
  expiresAt: Date;
  userAgent: string | null;
  current: boolean; // true for exactly one row, the request's own session
}
```

`GET` returns `{ items: SessionView[], truncated: boolean }`.

| Situation                                   | Response                            | Side effect                                  |
| ------------------------------------------- | ----------------------------------- | -------------------------------------------- |
| `GET` with a valid session                  | `200 { items, truncated }`          | None                                         |
| `DELETE /:id` naming one of the caller's    | `204`, empty body                   | One row deleted                              |
| `DELETE /:id` naming the caller's current   | `204`, empty body                   | One row deleted **and the cookie cleared**   |
| `DELETE /:id` naming another user's session | `404 { code: "not_found" }`         | **None** — the other user's row is untouched |
| `DELETE /:id` naming nothing that exists    | `404 { code: "not_found" }`         | None                                         |
| `DELETE /:id` with a non-uuid id            | `400 { code: "validation_failed" }` | None                                         |
| `DELETE` collection                         | `204`, empty body                   | Every other row for this user deleted        |
| Any of the three without a session          | `401 { code: "unauthorized" }`      | None                                         |

Error bodies keep the existing shape, raised with `notFound()` from
`src/lib/errors.ts`. The declared `400` schema reuses the `ErrorResponse` shape
**with the optional `details` array**, for the reason `src/routes/auth.ts`
records in a comment: `validation_failed` carries `details`, and the zod
serializer strips any key the schema does not declare. `401` is deliberately
**not** declared, matching `POST /api/auth/verify-email` — `requireAuth` raises
it before validation, and no declared schema means no serializer to strip it.

**Why a `404` and not a `403` for another user's session id:** AGENTS.md's rule,
unchanged. Every statement is scoped by `user_id` in the `WHERE` clause; nothing
is fetched and then checked in application code. A row that does not belong to
the caller does not exist as far as the response is concerned.

### Data model changes

One migration, `drizzle/0005_session_metadata.sql`, on the existing `sessions`
table. **Purely additive; nothing is dropped, renamed, or made `NOT NULL` in this
PR**, so it is legal alongside `src/` changes under
`scripts/ci/migration-safety.mjs` rule 2 and safe under a rolling deploy.

```sql
-- Catalogue-only: a nullable column with no default takes no table rewrite.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS public_id uuid;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_agent text;

-- New rows only; setting a default on an existing column rewrites nothing.
-- This is what keeps rows written by OLD instances mid-rollout addressable.
ALTER TABLE sessions ALTER COLUMN public_id SET DEFAULT gen_random_uuid();

-- Backfill. Row locks and new row versions, but readers are never blocked, so
-- authenticated requests served by the old image keep working throughout.
UPDATE sessions SET public_id = gen_random_uuid() WHERE public_id IS NULL;
```

Mirrored in `src/db/schema.ts` as `publicId: uuid('public_id').notNull().defaultRandom()`
and `userAgent: text('user_agent')`. `resetDb` in `tests/integration/helpers.ts`
already truncates `sessions`; no change there.

**Expand / contract, stated explicitly** (ADR 0003):

1. **Expand — this PR.** Both columns added nullable, `public_id` defaulted and
   backfilled in the same transaction, so from the moment the migration commits
   no row has a NULL `public_id` and no code path can create one.
2. **Contract — a later, migration-only PR.**
   `ALTER TABLE sessions ALTER COLUMN public_id SET NOT NULL;` The guard's
   `DESTRUCTIVE` list matches `SET NOT NULL`, so it must ship with no `src/`
   changes. It is filed as a checklist item on this feature's issue. Nothing
   depends on it: it converts a guarantee the migration already provides into one
   the database enforces.

**No new index, deliberately.** Both new query paths are `WHERE user_id = $1 AND
…`, and `sessions_user_id_idx` has existed since `0001_init.sql`. The index scan
reduces to one account's handful of rows before `public_id` or `expires_at` is
looked at, and before the `ORDER BY created_at DESC` sorts them — the same
argument F-004 and F-005 made for adding no index, and the same reason issue #11
(`CREATE INDEX CONCURRENTLY` vs. the transaction in `src/db/migrate.ts`) is
routed around rather than resolved. Worth saying once, since a reviewer will
check: a `CREATE UNIQUE INDEX` on `public_id` would slip past the guard's regex,
which only matches `CREATE INDEX`. This design does not use that loophole, and
does not need uniqueness — `gen_random_uuid()` plus a `user_id`-scoped lookup
makes a collision both astronomically unlikely and harmless.

**Why the `sessions` table and not a side table.** A session's device string and
its public name have exactly the session's lifetime, die with it on `DELETE`, and
are removed with the account by the existing `ON DELETE CASCADE` (which F-015
inherits for free). A side table would add a join to a query that runs on the
list endpoint and a second row to every login.

### Key decisions

Two ADRs, one decision each:

- **[`docs/adr/0014-sessions-have-a-public-id.md`](../../docs/adr/0014-sessions-have-a-public-id.md)**
  — a session is addressed by a surrogate uuid, never by its token hash.
- **[`docs/adr/0015-a-session-records-the-device-not-the-location.md`](../../docs/adr/0015-a-session-records-the-device-not-the-location.md)**
  — the user agent is stored, the IP address is not.

Summarised, with what was rejected:

**`sessions.id` is never serialised, and never appears in a URL.** It is
`sha256(token)` — a verifier for a live credential. Rejected: returning it as the
session's id, which is the smallest possible diff and puts a value derived from a
session token into a response body, a `DELETE` path, the access log, the browser
history, and any `Referer` — the same argument F-004 used to keep reset tokens
out of query strings. Also rejected: exposing `sha256(sessions.id)`, which needs
no migration and no column, but keeps the public name a function of the secret
(so a candidate token is still confirmable offline) and makes revocation a
`WHERE` on a computed expression. The surrogate uuid costs one additive column
and gives F-014 a session reference it can keep in an audit row after the session
itself is gone.

**The user agent is stored; the IP address is not.** Rejected: storing neither,
which leaves a user staring at three timestamps and no way to tell which is the
phone they lost — the feature's entire point. Rejected: storing the IP, or a
truncated IP, which turns `sessions` into a rolling location history for every
account, is PII that F-015 must then export and F-014 must then decide about,
depends on `TRUST_PROXY` being right to be worth anything, and is the one field
most likely to be pasted into a support ticket. The UA answers "which device is
this?" approximately; **revoke-everything-else** answers "I do not recognise one
of these" exactly, without needing the metadata to be precise.

**`DELETE /api/auth/sessions` keeps the current session alive.** Rejected:
destroying everything including the caller's, which is F-004's behaviour for a
good reason — it is the recovery path from a compromise, it is unauthenticated,
and it has no "current" session to keep. Here the caller is signed in on a device
they are holding and trust; logging them out too makes the common case ("kill the
one I do not recognise") end at the sign-in form. A user who genuinely wants
everything gone calls this and then `POST /api/auth/logout`, both of which exist.
Rejected for the same reason: an `?include_current=true` parameter, which is a
branch, a test matrix, and an OpenAPI field standing in for a second request the
client can already make.

**Revoking your own current session by id is allowed, and clears the cookie.**
Rejected: `409` for "that is the session you are using", which is a special case
every client then has to implement, to prevent something that is simply logging
out. The single-row revoke returns the deleted row's `id` (the hash) so the
handler can compare it to `request.sessionId` and clear the cookie in the same
response — otherwise the browser is left holding a token for a row that no longer
exists, and the next request 401s with a stale cookie still set.

**`204` with no body from both revoke endpoints.** Rejected: `200 { revoked: n }`.
Under ADR 0008 the client already renders the list it fetched, knows exactly
which rows were "others", and removes them on `204` with no refetch — the count's
only consumer would be a toast. The number is not lost: it goes to the counter
and the log line, where an operator can actually use it.

**No new rate-limit bucket and no new config key.** The global limiter already
keys on `request.user?.id ?? request.ip`, so these authenticated routes are
limited per account at `RATE_LIMIT_MAX`. Rejected: reusing `authRateLimit`.
That budget exists because `/api/auth/login` and friends are unauthenticated
credential surfaces that are cheap to hammer; these three require a valid session
and the worst outcome an attacker can force is deleting their own rows. Adding a
tighter bucket here would mostly create a way for a busy legitimate client to
`429` itself.

**The list is capped at 100 rows with a `truncated` flag, not paginated.**
Rejected: keyset pagination (ADR 0002) as used by `/api/todos`. Nothing caps how
many sessions an account can accumulate, so an unbounded list is not acceptable —
but paging through sessions is a need nobody has stated, and an `ORDER BY
created_at` deep enough to need a cursor would want a `(user_id, created_at)`
index, which is issue #11 again. The remedy for "too many sessions" is the revoke
-all-others button, not scrolling. `truncated: true` is one boolean that keeps a
security screen from quietly lying about what exists; rejected: silently
truncating, which is how a user misses the session they were looking for.

### Algorithm

**List.** After `requireAuth`:

```sql
SELECT id, public_id, created_at, expires_at, user_agent
  FROM sessions
 WHERE user_id = $1 AND expires_at > now()
 ORDER BY created_at DESC
 LIMIT 101;
```

Take the first 100; `truncated` is `rows.length > 100`. `current` is
`row.id === request.sessionId` — computed in application code from a column that
is selected and then **never serialised**, because the declared response schema
strips every key it does not name. `request.sessionId` has been set by the
session loader since F-002 and read by nothing; this is its first consumer.

**Revoke one.** After `requireAuth` and uuid validation, one statement — never a
`SELECT` followed by an ownership check:

```sql
DELETE FROM sessions WHERE user_id = $1 AND public_id = $2 RETURNING id;
```

No row → `notFound('Session not found')`. A returned `id` equal to
`request.sessionId` → `clearSessionCookie(reply, config)`. Then `204`.

The statement deliberately does **not** filter on `expires_at`: a session that
expires between the list call and the click should still revoke cleanly rather
than answer `404` for a row the user just saw. The outcome is identical either
way — the row is gone.

**Revoke the others.**

```sql
DELETE FROM sessions WHERE user_id = $1 AND id <> $2;
```

`$2` is `request.sessionId`. The handler raises `unauthorized()` if it is
somehow absent rather than running the statement without the exclusion — the
loader sets `request.user` and `request.sessionId` together so this cannot
happen, and the one-line guard is what stops a future refactor turning "sign out
everywhere else" into "sign out everywhere". The deleted row count feeds the
counter and the log line; the response is `204`.

**Capturing the user agent.** `createSession` in `src/plugins/auth.ts` gains a
`userAgent: string | null` parameter, passed by the two existing callers
(`POST /api/auth/register`, `POST /api/auth/login`) as
`truncateUserAgent(request.headers['user-agent'])`. A new pure helper in
`src/lib/session.ts`: trims, returns `null` for absent/empty, and slices to 256
characters. Nothing else in the request is read.

### Backlog split

F-006's out-of-scope list names "log out everywhere (F-009)" and points here, so
the screen has been waiting on this API. It does not ship in this PR: at ~470
hand-written lines this feature is already at the guidance, and a settings screen
is a page, a fetch client, a confirm interaction, and a Playwright journey.
**F-020 · Web UI — session management screen** is added to `specs/features.yaml`,
`deps: [F-009, F-006]`, `risk_tags: [frontend, auth, security]`, with a stub
spec. It owns the browser journey and inherits one hard constraint from here: the
user agent is attacker-controlled text and must be rendered with `textContent`,
never `innerHTML` (F-006's rule, which the CSP also backs).

Until it ships, this feature is reachable only by a client that speaks HTTP
directly — the same position F-004 shipped in.

## Acceptance criteria

- [ ] `GET /api/auth/sessions` with two live sessions for the caller returns both,
      newest first, and exactly one has `current: true` — the one whose cookie
      made the request — `integration: lists the caller's sessions newest first`
- [ ] The `GET` response body contains no value equal to the sha256 of any live
      session token, asserted against the raw serialised body, not the parsed
      object — `integration: never returns the session token hash`
- [ ] A session belonging to another user never appears in the list, and
      `DELETE /api/auth/sessions/:id` with that user's public id returns
      `404 not_found` while the other user's `GET /api/auth/me` still returns
      `200` — `integration: another user's session is neither listed nor revocable`
- [ ] An expired session row is not listed, while the caller's live ones are —
      `integration: expired sessions are not listed`
- [ ] `DELETE /api/auth/sessions/:id` for another of the caller's own sessions
      returns `204`, that session's cookie then gets `401` from
      `GET /api/auth/me`, and the caller's own session still works —
      `integration: revokes one named session`
- [ ] `DELETE /api/auth/sessions/:id` naming the caller's **current** session
      returns `204`, sets a cookie-clearing `Set-Cookie` for `sid`, and that
      cookie then gets `401` — `integration: revoking the current session logs it out`
- [ ] `DELETE /api/auth/sessions` returns `204`, leaves the caller's current
      session working, `401`s every other session of theirs, and leaves a third
      account's sessions untouched —
      `integration: signs out every other session and nobody else's`
- [ ] `DELETE /api/auth/sessions` with no other sessions returns `204` and deletes
      nothing — `integration: revoking others is a no-op at one session`
- [ ] `DELETE /api/auth/sessions/:id` with a non-uuid id returns
      `400 validation_failed` with a **populated `details` array**, proving the
      declared `400` schema does not strip it —
      `integration: rejects a malformed id without truncating the error body`
- [ ] All three routes return `401 unauthorized` with no cookie, and with a cookie
      naming a deleted session, and no session row is touched in either case —
      `integration: every session route requires authentication`
- [ ] A session created by a request carrying `User-Agent: X` lists with
      `userAgent: "X"`; one created with no header lists `userAgent: null`; a
      1000-character header is stored and returned at exactly 256 characters —
      `integration: captures the user agent at sign-in`
- [ ] A session row written before this feature shipped (simulated by clearing
      `user_agent` on an existing row) lists with `userAgent: null` and is still
      revocable — `integration: a session with no captured device still works`
- [ ] With 101 live sessions seeded for one user, `GET` returns exactly 100 items
      and `truncated: true`; with 100, `truncated: false` —
      `integration: the session list is capped and says so`
- [ ] No log line produced across a list-and-revoke cycle contains the user agent,
      any public id, or any session token or hash, at any level, asserted against
      a captured log stream via the `logStream` build option —
      `integration: session routes log no identifiers`
- [ ] `/metrics` exposes `sessions_revoked_total` with `scope` covering `single`
      and `others`, and `others` advances by the number of rows actually deleted
      — `integration: exposes session revocation counters`
- [ ] `truncateUserAgent` returns `null` for `undefined`, `''`, and `'   '`,
      returns a trimmed string unchanged under 256 characters, and returns exactly
      256 for anything longer — `unit: truncateUserAgent`
- [ ] `openapi.json` documents all three routes with their declared response codes
      — `npm run openapi:check` fails if the checked-in file is stale

## Test plan

| Layer       | Cases                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unit        | `truncateUserAgent`: absent, empty, whitespace-only, short, exactly 256, 1000 characters, and a multi-byte string that must not be cut into an invalid sequence (`tests/unit/session.test.ts`, alongside the existing token cases)                                                                                                                                                                                                                                                                                                                                                                                                       |
| integration | `tests/integration/sessions.test.ts`. **happy path** (list two, revoke one, revoke the rest) · **validation failure** (non-uuid id, `details` preserved) · **unauthenticated** (all three routes, no cookie and a dead cookie) · **other user's resource** (A cannot see, cannot revoke, and does not disturb B — the case that matters most here) · current-session marking · current-session revoke clears the cookie · expired rows excluded · user agent captured, absent, and truncated · NULL `user_agent` on a pre-existing row · the 100-row cap and `truncated` · raw-body scan for the token hash · log-stream scan · counters |
| e2e         | **None, deliberately.** There is no browser surface until F-020, so an "e2e" would be `request.delete()` calls duplicating the integration suite at the cost of a container boot — the argument F-004 and F-008 made. Worse here: `deploy.yml` runs Playwright against `STAGING_URL`, so the suite would be creating and destroying real sessions on a deployed environment on every deploy, with `retries: 2`. The journey lands with F-020, where there is a page to drive.                                                                                                                                                            |
| load        | No new k6 scenario. `GET /api/auth/sessions` is one index scan over a handful of rows on a table already read on every authenticated request, and the revokes are rare. The one change on a hot path is that `createSession` now writes two more columns on login, which the existing auth scenario already measures.                                                                                                                                                                                                                                                                                                                    |

## Security considerations

**The session token hash never leaves the server.** `sessions.id` is
`sha256(token)`; anything that echoes it hands out a verifier for a live
credential and puts it into access logs and browser history the moment it appears
in a path. The public uuid exists for exactly this reason (ADR 0014), and the
mechanical guard is the declared zod response schema, which strips every
undeclared key — so the internal `id` selected for the `current` comparison
cannot reach a response even by accident. The raw-body assertion is the test that
proves it stays that way.

**Cross-account isolation.** Every statement carries `user_id = $caller` in the
`WHERE`; nothing is read and then checked. A public id belonging to someone else
returns `404`, not `403`, so the endpoint is not an existence oracle for other
accounts' sessions. This is the acceptance criterion to re-read before approving.

**A stolen session can revoke the real user's sessions.** True, and accepted. An
attacker holding a session cookie can already read and write everything the
account owns; what they gain here is the ability to sign the legitimate user out,
which is loud rather than stealthy — the victim is returned to the sign-in form,
still knows their password, and signing back in is what lets them revoke the
attacker. They cannot lock the user out: there is no authenticated password-change
endpoint, and `POST /api/auth/password-reset` needs the mailbox. This is the
reason step-up authentication was rejected: it would protect against an attacker
who already has everything the step-up would be gating.

**The user agent is attacker-controlled input.** It is truncated to 256
characters at write time (an unbounded header would otherwise be stored
verbatim), stored raw, returned only to the account that produced it, and
**never logged** — the same rule AGENTS.md already applies to addresses and
tokens, and the reason it matters more here is log injection via newline
characters. It is returned as a JSON string, so there is no injection into the
response itself; the risk is a screen that renders it as HTML, which is F-020's
constraint and is recorded there and in ADR 0015.

**No IP address, and therefore no location history.** ADR 0015. A session table
that remembers where every sign-in came from is a surveillance dataset with the
lifetime of a session, an export obligation under F-015, and one plausible
subpoena away from mattering. It is also only as trustworthy as `TRUST_PROXY`.

**Revocation is immediate because sessions are database-backed** (ADR 0004) —
one `DELETE` and the next request's loader finds nothing. One forward hazard,
stated here because it will not be obvious to whoever hits it: ADR 0004's own
escape hatch is "a short-TTL cache in front of the session lookup", and F-012
brings a cache into the codebase. **Any cache over the session lookup bounds
revocation latency by its TTL and must invalidate on these two endpoints**,
which turns this feature from "instant" into "eventually" if it is missed.

**CSRF.** Both mutating routes are `DELETE`, covered by the existing `onRequest`
origin hook in `src/app.ts` wherever `ALLOWED_ORIGINS` is populated — which,
per ADR 0007, is everywhere a browser client is served — and by `SameSite=Lax`,
which does not send the cookie on a cross-site `DELETE` at all.

**Rate limiting.** The global per-account limit applies unchanged; see the key
decision above for why no tighter bucket is added. F-011 makes that limit
distributed and this feature inherits the change for free.

**PII.** One new category of personal data enters the database: a device string.
It lives on a row that already dies with the session and is removed with the
account by the existing cascade, so F-015's deletion story does not grow — only
its export story, by one field.

## Observability

- **`sessions_revoked_total{scope="single"|"others"}`** — a new Prometheus
  counter in `src/plugins/metrics.ts`, passed into `registerSessionRoutes` the
  way `passwordResets` is passed into `registerAuthRoutes`. Incremented by the
  number of rows actually deleted, so `others` carries how wide each sweep was.
  The reading that matters: a sustained rise in `scope="others"` across accounts
  is a population of users finding sessions they do not recognise, which is a
  credential-stuffing signal arriving through the front door rather than through
  the login error rate. A flat zero after F-020 ships means the screen is broken
  or unreachable.
- **One structured log line per revocation:**
  `request.log.info({ session: { action: 'revoke', scope, count } })` — the
  outcome and a number, never a public id, a hash, or a user agent. It exists so
  a support conversation ("everything signed me out on Tuesday") is answerable.
- **`http_request_duration_seconds{route="/api/auth/sessions"}` and
  `{route="/api/auth/sessions/:id"}`** already come from the existing
  `onResponse` hook, with the route template keeping cardinality at two labels.
  The list endpoint's p95 is the early warning for an account accumulating
  thousands of sessions, since it is the only query here whose cost grows.
- **Not measured:** how many sessions exist in total, which would be a gauge over
  a `COUNT(*)` on every scrape. If session growth ever needs watching, the list
  endpoint's latency and the `truncated` flag get there first.

## Rollout

**No feature flag and no configuration.** The three routes are registered
unconditionally in every environment, so the deployed contract matches
`openapi.json` everywhere — the position F-004 took, for the same reason. There
is no new environment variable to set before merging.

**Order.** Merge. One PR, one additive migration, applied at container start by
`scripts/docker-entrypoint.sh` before the server boots. During the rolling
deploy, old instances keep inserting sessions without naming the new columns:
`public_id` is filled by the column default and `user_agent` stays NULL, which
the API reports honestly as `null`. No window exists in which a session is
unaddressable.

**Rollback at 2am.** Redeploy the previous image. Both columns are nullable and
unread by the old code, the routes vanish with the image, and no existing column,
response, or cookie behaviour was modified. The migration can and should stay
applied. Nothing needs undoing, and no session is invalidated by the rollback
itself.

**Follow-ups this creates:**

- **The contract migration** — `ALTER TABLE sessions ALTER COLUMN public_id SET
NOT NULL`, migration-only, tracked as a checklist item on this feature's issue.
- **F-020** — the session management screen (added by this plan). Until it ships
  the feature has no user-facing surface.
- **F-014** — the audit log now has a stable, non-credential session identifier
  to reference, which is why it depends on this feature.
- **F-015** — the export must include `user_agent`; deletion is already covered by
  the existing cascade.
- **#11** — the `CREATE INDEX CONCURRENTLY` conflict, routed around again rather
  than fixed.

**Diff budget.** Estimated ~470 hand-written lines: migration (~20),
`src/db/schema.ts` (~10), `src/lib/session.ts` (~12), `src/plugins/auth.ts`
(~8), `src/routes/auth.ts` (~4 at the two `createSession` calls),
`src/routes/sessions.ts` (~135), `src/app.ts` and `src/plugins/metrics.ts`
(~15), unit tests (~35), integration tests (~230), plus a regenerated
`openapi.json` (generated, excluded). At the ~500 guidance, which is why F-020
exists rather than a screen in this PR. If it runs over, cut the 100-row cap
case and the pre-existing-NULL-user-agent case — **never** the cross-account
isolation, the raw-body hash scan, or the revoke-others scoping cases, which are
the feature's security properties.
