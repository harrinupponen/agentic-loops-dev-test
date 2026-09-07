# F-004 · Password reset via emailed single-use token

> Status is tracked in `specs/features.yaml`, not here.

## Problem

A user who forgets their password is permanently locked out. There is no recovery
path, and support has no safe way to help them without handling credentials.

## Scope

**In scope**

- Request a reset by email address
- Consume a single-use, time-limited token to set a new password
- Invalidate all existing sessions when the password changes

**Out of scope**

- Choosing or operating an email provider beyond a single adapter interface
- Account recovery by any other channel (SMS, security questions, support)
- Rate limiting beyond the per-route limit (F-011 makes it distributed)
- Notifying the user of the change by email — that lands with F-005
- **Browser screens for either step, and the full browser journey that goes with
  them.** F-006 explicitly deferred reset screens ("Neither API exists yet; the UI
  gains them when they do"). This feature builds the API; **F-017**, added to the
  backlog by this plan, builds the screens and owns the end-to-end journey. See
  "Why there is no e2e layer here".
- Password strength rules beyond the existing 12–200 character `Credentials`
  schema, and any check that the new password differs from the old one
- Idempotency keys on either endpoint. F-007 deliberately kept `POST /api/auth/*`
  out of that feature; nothing here changes that.
- Authenticated password change ("change my password while signed in"). Different
  threat model, different endpoint, nobody has asked for it.

## Design

### API changes

Two new **public** endpoints. Both are registered unconditionally, in every
environment, so the deployed contract matches `openapi.json` everywhere.

| Method | Path                               | Auth | Notes                                                                                                                         |
| ------ | ---------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/auth/password-reset`         | none | Body `{ email }`. **Always `202` with an empty body**, known address or not. Rate limit `PASSWORD_RESET_RATE_LIMIT_MAX`/hour. |
| POST   | `/api/auth/password-reset/confirm` | none | Body `{ token, password }`. `204` on success. Rate limit `AUTH_RATE_LIMIT_MAX`/minute (the existing `authRateLimit`).         |

Request (`POST /api/auth/password-reset`):

| Situation                                            | Response                            | Side effect                                                     |
| ---------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------- |
| Address matches an account, no token issued recently | `202`, empty body                   | Token row written (replacing any previous one), mail dispatched |
| Address matches an account, token issued < 60 s ago  | `202`, empty body                   | **Nothing.** Previous token stays valid, no second mail         |
| Address matches no account                           | `202`, empty body                   | None                                                            |
| Malformed or missing email                           | `400 { code: "validation_failed" }` | None                                                            |
| Over the rate limit                                  | `429 { code: "rate_limited" }`      | None                                                            |

Confirm (`POST /api/auth/password-reset/confirm`):

| Situation                                 | Response                            | Side effect                                                     |
| ----------------------------------------- | ----------------------------------- | --------------------------------------------------------------- |
| Token exists and is unexpired             | `204`, empty body                   | Password replaced, token row deleted, **every** session deleted |
| Token unknown, already used, or replaced  | `400 { code: "invalid_token" }`     | None                                                            |
| Token exists but past `expires_at`        | `400 { code: "token_expired" }`     | None (the transaction rolls back, the dead row stays)           |
| Token wrong length/charset, weak password | `400 { code: "validation_failed" }` | None                                                            |
| Over the rate limit                       | `429 { code: "rate_limited" }`      | None                                                            |

Success does **not** create a session. The user is sent back to the sign-in form,
which proves the new password works and keeps this endpoint from being a way to
mint a session without ever presenting a password.

Error bodies keep the existing shape: `{ error: { code, message }, requestId }`,
raised with `badRequest()` from `src/lib/errors.ts`.

**Declared response schemas.** Per AGENTS.md, every returned status code gets a
schema, so `202`, `204`, and `400` are all declared. The `400` schema reuses the
`ErrorResponse` shape from `src/routes/todos.ts` **with an optional `details`
array added** — `validation_failed` carries `details` (see
`src/plugins/errors.ts`) and the zod serializer strips undeclared keys, so a
schema without it would silently truncate every validation error on these two
routes. F-007 hit the neighbouring version of this trap (a mismatched schema
turns the response into a `500`); it gets an integration assertion here.

### Data model changes

One migration, `drizzle/0003_password_reset_tokens.sql`, **purely additive**.
Nothing is renamed, dropped, or backfilled, so expand is the whole plan and there
is no contract step.

```sql
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  -- One live token per account, enforced by the schema rather than by a query.
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- sha256 of the opaque token, exactly as sessions.id stores a session token.
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
```

Mirrored in `src/db/schema.ts`. `tests/integration/helpers.ts` adds the table to
the `TRUNCATE` list in `resetDb`.

**No standalone `CREATE INDEX`, deliberately.** Both access paths are served by
constraint indexes created with the table:

- issue: `INSERT ... ON CONFLICT (user_id)` — the primary key
- consume: `DELETE ... WHERE token_hash = $1` — the unique constraint

This matters beyond tidiness. Issue #11 is live: `scripts/ci/migration-safety.mjs`
requires every new `CREATE INDEX` to be `CONCURRENTLY`, while `src/db/migrate.ts`
runs each file inside `BEGIN`/`COMMIT`, where Postgres refuses `CONCURRENTLY`.
Any migration adding an index today passes CI and then fails at deploy. F-004 does
not need one, so it does not resolve that conflict — same position F-007 took.
Constraint indexes on a table created empty in the same statement take no lock on
anything, so the guard's intent is satisfied in substance and not merely in letter.

**Retention needs no sweeper.** The primary key caps the table at one row per
account. A consumed token is deleted; a superseded one is overwritten by the
upsert; an abandoned one is inert until the user asks again. `ON DELETE CASCADE`
removes it with the account (relevant to F-015). F-007 needed an opportunistic
sweep because its key space was unbounded; this one is bounded by construction.

**Rollback:** the previous image ignores an unknown table. The migration can stay
applied through a rollback; drop it in its own PR if the feature is abandoned.

### Configuration

Three new keys in `src/config.ts`:

```
PASSWORD_RESET_TTL_MINUTES        int, min 1, default 30
PASSWORD_RESET_RATE_LIMIT_MAX     int, min 1, default 5      # per hour, per IP
MAIL_TRANSPORT                    enum('console','drop'), default 'console'
```

All three are required fields on `Config` (defaulted, not optional), so
`scripts/dump-openapi.ts` — the only place that builds a `Config` literal — fails
typecheck until it is updated. F-006 established that as the mechanism that keeps
a new key from being silently absent somewhere.

`.env.example` gains all three with comments.

### Mail is an injected adapter, and the development transport refuses production

`src/lib/mailer.ts`:

```ts
export interface Mailer {
  /** Names the transport in logs and metrics; must be low-cardinality. */
  readonly transport: string;
  /** Must not hang: a network implementation applies its own timeout. */
  sendPasswordReset(message: { to: string; token: string; expiresAt: Date }): Promise<void>;
}
```

Two implementations, chosen by `MAIL_TRANSPORT`:

- **`console`** (default) — writes one line to `process.stdout` containing the
  address and the raw token, so a developer can complete the flow locally. It
  **throws at construction when `NODE_ENV === 'production'`**, following ADR 0007:
  a transport that prints credentials would put live reset tokens into the log
  aggregator, and "remember not to set it in prod" is not a control.
- **`drop`** — resolves without sending. This is what production runs until a real
  transport exists. The endpoints still work, the token is still issued, and
  `mail_messages_total{transport="drop"}` says out loud that nothing is being
  delivered.

`buildApp` constructs the mailer and passes it to `registerAuthRoutes`, the same
way `db`, `config`, and the idempotency hook are passed today. `BuildOptions`
gains an optional `mailer?: Mailer` override, mirroring the existing `logStream`
option; that is the seam integration tests use to read the raw token, and it is
the reason **no test-only HTTP endpoint or "get my token" route exists anywhere**.

No email provider, SDK, template engine, or `APP_BASE_URL` is added. The adapter
takes the raw token; the transport composes the message. A reset **URL** needs a
page to point at, and there is no page until F-017 — inventing a link format now
would be extensibility for a need nobody has stated.

### Token format and lifetime

Follows the session precedent in `src/lib/session.ts` exactly: 32 random bytes,
base64url (43 characters) to the user, sha256 hex in the database. New module
`src/lib/reset-token.ts` with `generateResetToken()`, `hashResetToken()`, and the
`^[A-Za-z0-9_-]{43}$` schema. It duplicates two one-line functions rather than
importing from `session.ts`, because those names describe sessions and
`src/lib/session.ts` is a CODEOWNERS-protected credential file that F-009 is about
to change. If a third token type appears, the two get lifted into a shared module
**then**, not now.

Lifetime is `PASSWORD_RESET_TTL_MINUTES`, default **30**. Long enough to find the
mail on another device, short enough that a token sitting in an unattended inbox
or a mail-scanner log is stale before it is useful.

### Algorithm

**Request.** After validation and the rate limit:

1. Look up the user by email. `Credentials` already lowercases, so the same
   normalisation applies here.
2. Generate a token and hash it **on both branches**, matching how
   `src/routes/auth.ts` always runs `verifyPassword` against `DUMMY_HASH` so login
   timing does not reveal account existence. On the unknown branch the values are
   discarded.
3. If a user was found, claim the slot in one statement:

   ```sql
   INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
   VALUES ($1, $2, now() + $ttl)
   ON CONFLICT (user_id) DO UPDATE
     SET token_hash = EXCLUDED.token_hash,
         expires_at = EXCLUDED.expires_at,
         created_at = now()
     -- 60-second per-account cooldown. Hard-coded, like F-007's in-progress
     -- lease: it is a property of the design, not a knob anyone should turn.
     WHERE password_reset_tokens.created_at < now() - interval '60 seconds'
   RETURNING user_id;
   ```

   A returned row means a new token was issued and the previous one is now dead.
   No row means a token was issued for this account within the last 60 seconds:
   **send nothing, leave the existing token valid, still reply `202`.** That is the
   real defence against using someone's inbox as a weapon, and it lives in the
   database, so it works per account rather than per IP.

4. Dispatch the mail **without awaiting it** and reply `202` immediately (see the
   decision below).

**Confirm.** After validation and the rate limit:

1. `hashPassword(newPassword)` — argon2id, ~50–100 ms — **before** opening the
   transaction. Two reasons: it keeps a slow CPU-bound operation out of a held
   database connection, and it makes a valid and an invalid token cost the same
   wall-clock time.
2. In one transaction:
   - `DELETE FROM password_reset_tokens WHERE token_hash = $1 RETURNING user_id, expires_at`
     — the atomic claim. Deleting _is_ the single-use check: there is no `used_at`
     column to forget to check, and two concurrent confirms cannot both win.
   - No row → throw `badRequest('invalid_token', ...)`; the transaction rolls back.
   - `expires_at <= now()` → throw `badRequest('token_expired', ...)`; the
     transaction rolls back, so the dead row survives and is overwritten by the
     next request. Distinguishing the two is safe: only someone already holding a
     token can reach either, so neither says anything about an account.
   - `UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $3`
   - `DELETE FROM sessions WHERE user_id = $3` — served by `sessions_user_id_idx`.
3. `204`.

### Key decisions

See **`docs/adr/0009-single-use-recovery-tokens.md`** and
**`docs/adr/0010-mail-is-an-injected-adapter.md`**. Summary:

**`202` for every address, known or not.** Rejected: `404` for an unknown address,
which turns the endpoint into a clean user-enumeration oracle, and `200` with a
body describing what happened, which is the same leak in a nicer wrapper. `202`
rather than `204` because "accepted; if that address has an account, mail is on
its way" is exactly what the server is promising.

**One live token per account, enforced by a primary key on `user_id`.** Rejected:
a random `id` primary key with a `user_id` index and "invalidate the others on
issue". That needs a second index (see issue #11), a second statement, and a
`used_at` column, and it makes "how many live tokens does this account have?" a
query rather than an invariant. The cost is real and stated: a user who requests
twice and then clicks the **first** link gets `invalid_token`. That is the
standard behaviour of every major provider and the safer of the two failure modes.

**Consuming a token deletes the row.** Rejected: a `used_at` timestamp, which
leaves spent credentials in the table, needs a partial index to stay cheap, and
turns single-use into an application-level check that a future refactor can drop.

**60-second per-account cooldown inside the upsert.** The per-IP rate limit does
not protect a victim from a distributed attacker filling their inbox; the cooldown
does, at the cost of zero extra statements. Rejected: a dedicated
`last_requested_at` column (the row already has `created_at`) and doing nothing
(mail bombing is the most common real-world abuse of this endpoint).

**Every session is destroyed, including any the requester holds.** Rejected:
"all except the current one" — the endpoint is unauthenticated, so there is no
current session to keep, and password reset is the recovery path from an account
compromise. Leaving a single session alive defeats the entire point.

**The mail send is not awaited, and its failure never changes the response.**
Rejected: awaiting the send and returning `500` on failure, which leaks account
existence perfectly (a `500` is only reachable for an address that exists) and
puts the mail provider's p99 on the user's response time; and awaiting it while
swallowing the error, which fixes the status-code leak but leaves a several-hundred
millisecond timing leak that is trivially measurable. The cost is that a send
failing after the response is only visible in logs and metrics, which is what the
`mail_messages_total` counter is for.

**No session is created on success.** Rejected: signing the user in, which is
convenient and makes the endpoint a session-minting oracle for anyone who obtains
a token, and skips the one step that proves the new password actually works.

**The token travels in a POST body, never in a query string.** A `GET
/reset?token=` API endpoint would put a live credential into access logs, browser
history, and any `Referer` sent to a third party. When F-017 ships a reset page,
the token may appear in that page's URL, but it reaches the **server** only in a
body — that constraint is the page's to honour, and it is recorded in F-017.

### Backlog split

The stub's test plan asked for an e2e journey ("forgot password → reset → log in
with the new password"). There is no browser to drive it: F-006 put reset screens
out of scope, so this feature has no UI. Rather than write a UI-less HTTP-only
spec that duplicates the integration suite (see "Why there is no e2e layer here"),
this plan adds **F-017 · Web UI — password reset screens** to `specs/features.yaml`,
`deps: [F-004, F-006]`. It owns the two screens and the full browser journey.

The problem statement — "a user who forgets their password is permanently locked
out" — is not actually solved for a human being until F-017 ships. F-004 makes the
capability exist and correct; F-017 makes it reachable.

## Acceptance criteria

- [ ] `POST /api/auth/password-reset` for a registered address returns `202` with
      an empty body and writes exactly one `password_reset_tokens` row for that
      user — `integration: issues a token for a known address`
- [ ] The status code, headers, and body are identical for a registered and an
      unregistered address, and the unregistered one writes no row —
      `integration: an unknown address is indistinguishable from a known one`
- [ ] The token handed to the mailer is 43 base64url characters and its sha256
      equals the stored `token_hash`; the raw token is **not** in the row —
      `integration: stores only the hash of the token`
- [ ] A second request within 60 s returns `202`, sends **no** second message, and
      leaves the first token usable —
      `integration: a second request inside the cooldown is silently ignored`
- [ ] A second request after the cooldown replaces the row, and the **first**
      token is then rejected with `400 invalid_token` —
      `integration: issuing a new token invalidates the previous one`
- [ ] A valid token plus a valid password returns `204` and the user can log in
      with the new password and not with the old one —
      `integration: consumes a token and sets the new password`
- [ ] Replaying the same token returns `400 invalid_token` and the password is
      unchanged — `integration: a token cannot be used twice`
- [ ] A token whose `expires_at` is in the past returns `400 token_expired` — a
      code distinct from `invalid_token` — and the password is unchanged —
      `integration: an expired token is rejected with its own code`
- [ ] A syntactically valid but unknown token returns `400 invalid_token` —
      `integration: an unknown token is rejected`
- [ ] Confirming destroys every session for that user: two sessions created before
      the reset both return `401` from `GET /api/auth/me` afterwards, and a third
      user's session is untouched —
      `integration: a password change invalidates every session for that user only`
- [ ] Confirming returns `204` and sets **no** session cookie —
      `integration: a reset does not sign the user in`
- [ ] A token of 42 or 44 characters, or containing `/`, and a password under 12
      characters, each return `400 validation_failed` with a populated `details`
      array (proving the declared `400` schema does not strip it) —
      `integration: rejects malformed input without truncating the error body`
- [ ] With `PASSWORD_RESET_RATE_LIMIT_MAX=1`, the second request from the same IP
      inside the window returns `429 rate_limited` while `POST /api/auth/login`
      still succeeds — the reset limit is tighter than, and independent of, the
      auth limit — `integration: the reset request endpoint has its own tighter limit`
- [ ] No log line produced during a full request-and-confirm cycle contains the
      raw token or the email address, at any log level (asserted against a
      captured log stream via the existing `logStream` build option) —
      `integration: neither the token nor the address is ever logged`
- [ ] `buildApp` rejects when `MAIL_TRANSPORT=console` and `NODE_ENV=production`,
      and resolves for `development` and `test` —
      `integration: the console mail transport refuses to run in production`
- [ ] With `MAIL_TRANSPORT=drop`, both endpoints are still registered and the flow
      still issues and consumes tokens; `mail_messages_total{transport="drop"}`
      increments — `integration: the drop transport keeps the API surface intact`
- [ ] `/metrics` exposes `password_reset_total` with `outcome` covering
      `requested`, `consumed`, `expired`, and `invalid`, and
      `mail_messages_total` with `kind`, `transport`, and `outcome` —
      `integration: exposes password reset counters`
- [ ] `password_reset_total` increments identically for a known and an unknown
      address — the metric is not an enumeration oracle —
      `integration: the request counter does not distinguish known addresses`
- [ ] `/metrics` returns the Prometheus body for a correct bearer token, and
      `401 unauthorized` in the standard error shape when the header is missing,
      wrong, a prefix of the real token, or the right token under another
      scheme — `integration: metrics authentication` (six cases)
- [ ] With `METRICS_TOKEN` unset outside production, `/metrics` still serves
      unauthenticated — the documented development default —
      `integration: serves unauthenticated outside production when no token is configured`
- [ ] `loadConfig` throws under `NODE_ENV=production` when `METRICS_TOKEN` is
      unset, the placeholder value, or shorter than 32 characters, and accepts a
      strong one — `unit: loadConfig` metrics token cases
- [ ] `bearerTokenMatches` is length-independent (no throw, no early return) and
      never matches an empty expected token — `unit: bearerTokenMatches`
- [ ] `generateResetToken()` returns 43 base64url characters, differs across
      1000 calls, and `hashResetToken()` matches `sha256` of the input —
      `unit: reset token generation and hashing`
- [ ] `openapi.json` documents both routes with `202`, `204`, and `400` responses
      — `npm run openapi:check` fails if the checked-in file is stale

## Test plan

| Layer       | Cases                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unit        | `generateResetToken` length, charset, uniqueness across 1000 draws · `hashResetToken` matches a known sha256 vector and is stable · the token zod schema accepts 43 chars and rejects 42/44/`+`/`/`/empty · expiry arithmetic from `PASSWORD_RESET_TTL_MINUTES`                                                                                                                                                                                                                                                                                                                                                                                            |
| integration | happy path (issue → consume → log in with the new password) · validation failure on both routes, `details` preserved · **unauthenticated: both routes are public by design — asserted, and asserted to set no cookie on either** · **other user's resource: user A's token cannot change user B's password, and B's sessions survive A's reset** · replay · expiry · unknown token · cooldown · supersede · session invalidation scope · rate limit on the request route · log-content scan for the token and the address · `console` transport refuses production · `drop` transport keeps the flow working · metrics presence and enumeration-neutrality |
| e2e         | **None. Deliberate — see below.** The journey lands with F-017, where there is a browser to drive.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| load        | No new k6 scenario. This is a once-per-user-per-year path, not a hot one; the only cost worth watching is the argon2 hash on confirm, which is the same cost `POST /api/auth/login` already pays and already measures. Adding a scenario would measure argon2 twice.                                                                                                                                                                                                                                                                                                                                                                                       |

**Why there is no e2e layer here.** AGENTS.md asks for all three layers, so the
absence is argued rather than assumed:

1. There is no browser surface. An "e2e" would be `request.post()` calls with no
   page, duplicating the integration suite at the cost of a container boot.
2. It could not complete the journey anyway. The raw token only exists inside the
   mailer, and the only safe way to read it is the injected fake — which lives in
   the integration process. Reading it from the database is impossible by design
   (only the hash is stored), and any HTTP route that returned it would be a token
   oracle.
3. A DB-seeding e2e cannot run against a deployed target: `deploy.yml` runs
   `npx playwright test` with `E2E_BASE_URL` pointed at `STAGING_URL`, where the
   whole suite runs and no `DATABASE_URL` exists. Excluding it would need
   `test.skip`, which `scripts/ci/test-integrity.mjs` forbids outright.
4. Even a token-free e2e — asserting known and unknown addresses get identical
   `202`s — would fire real reset requests at staging on **every deploy**, against
   a deliberately tight per-IP hourly limit, with `retries: 2`. This repo has
   already been bitten by exactly that shape (#30, the e2e job hitting the real
   `AUTH_RATE_LIMIT_MAX`). A test that has to be exempted from the feature's own
   primary security control is worse than no test.

The debt is scheduled, not waived: F-017 is in the backlog and its e2e is the
journey this stub asked for.

## Security considerations

This is the single most attacked endpoint in most applications. A weak token, a
leaked token in a log, a missing single-use check, or a timing difference between
known and unknown addresses each turn it into full account takeover.

**Token strength and storage.** 256 bits from `crypto.randomBytes`, stored as
sha256. A database leak yields no live tokens, exactly as with `sessions.id`.
Brute force is not a consideration at 2^256, but the confirm route is rate limited
anyway so the attempt costs an attacker something.

**User enumeration.** The mitigations are stacked, because one of them is never
enough:

- identical status, headers, and body on both branches
- token generation and hashing performed on both branches (the `DUMMY_HASH`
  precedent from login)
- the mail send moved off the response path entirely, so the mail provider's
  latency cannot be measured through the response
- `password_reset_total` deliberately carries no label distinguishing the branches

The residual is one indexed `INSERT` on the known branch versus none on the
unknown branch — sub-millisecond, well inside network jitter, and not removable
without writing a decoy row somewhere. It is documented rather than hidden, and
the rate limit is the control that actually bounds probing.

**`/metrics` is an enumeration oracle for this feature, and that needs a decision
before merge.** `src/plugins/metrics.ts` registers `/metrics` with no
authentication. `mail_messages_total{kind="password_reset",outcome="sent"}`
increments **only** when the address matched an account, so anyone who can read
`/metrics` can test an address by requesting a reset and reading the counter —
cleanly, with no timing analysis. Options considered:

- Drop the mail counter. Rejected: a mail transport with no delivery signal is how
  you find out about an outage from users, and this feature's most likely failure
  is silent non-delivery.
- Aggregate it so it cannot be attributed to one request. Rejected: Prometheus
  counters are monotonic and scraped often; there is no aggregation that survives
  a patient attacker.
- Keep the counter and require that `/metrics` is not internet-reachable.
  Originally chosen, then **overtaken by review**: `/metrics` was verified to be
  publicly fetchable on both deployed environments, with no ingress rule in front
  of it. There was nothing to confirm — the precondition was already false.
- **Chosen (review decision, implemented in this PR): keep the counter and
  authenticate `/metrics`.** A bearer token (`Authorization: Bearer <token>`)
  compared in constant time against `METRICS_TOKEN`, because this is a machine
  endpoint and a session cookie is the wrong shape for a scraper. Per ADR 0007
  the control fails closed at boot: `NODE_ENV=production` with `METRICS_TOKEN`
  unset, placeholder, or under 32 characters refuses to start. Outside production
  the default stays empty and the endpoint stays open, so local development and
  the integration suite keep working; the boot check is what guarantees the open
  path exists nowhere reachable. **Rollout precondition:** `METRICS_TOKEN` set on
  Sevalla staging and production before merge. F-008 keeps the larger question of
  isolating the endpoint on its own port or network.

**Inbox bombing.** The 60-second per-account cooldown is in the database, so it
holds across instances and across source IPs — unlike the per-IP rate limit, which
is per-process in-memory until F-011. An attacker who knows an address can cause
at most one mail per minute to it, and cannot invalidate a token the victim is
about to click any faster than that.

**Session invalidation.** `DELETE FROM sessions WHERE user_id = $1` runs inside the
same transaction as the password update, so there is no window where the new
password is live and an attacker's old session still is. It is scoped by
`user_id`; an integration test asserts a third party's sessions survive.

**Logging.** The token and the address are never passed to `request.log`, in any
branch, at any level. Request bodies are not logged and the existing `redact`
config covers headers. The one deliberate exception is the `console` transport,
which writes the address and token to **stdout, not the app logger**, and which
throws at boot in production so that exception can never reach an aggregator. An
integration test scans a captured log stream for both values.

**Argon2 as a CPU amplifier.** Confirm hashes the submitted password before it
knows whether the token is valid. That is what equalises timing, and it means a
garbage token still costs ~19 MiB and ~50 ms of server CPU. `AUTH_RATE_LIMIT_MAX`
(10/min per IP) is the bound; `under-pressure` sheds load if it is ever not enough.
Called out because the ordering looks wasteful until you know why it is that way.

**PII.** Email addresses reach one new place: the `Mailer`. They are not stored in
the new table (it holds `user_id` only), not logged, and not returned in any
response. `ON DELETE CASCADE` ties token rows to the account for F-015.

**CSRF.** Both routes are `POST` and are covered by the existing origin hook in
`src/app.ts` wherever `ALLOWED_ORIGINS` is populated — which, per ADR 0007, is
everywhere a browser client is served.

## Observability

- **`password_reset_total{outcome="requested|consumed|expired|invalid"}`** — a new
  Prometheus counter in `src/plugins/metrics.ts`, passed into `registerAuthRoutes`
  the way `metrics.idempotencyRequests` is passed into the idempotency plugin.
  `requested` increments once per accepted request **regardless of whether the
  address matched**, which is what keeps it from being an enumeration oracle. The
  signal that matters is the ratio: `requested` climbing while `consumed` stays
  flat means either mail is not arriving or the links are expiring, which is
  precisely the stub's "delivery failure or enumeration attempt" alarm. Sustained
  `invalid` means either an attack or a mail client mangling tokens.
- **`mail_messages_total{kind="password_reset",transport,outcome="sent|failed"}`** —
  the only proof that the un-awaited send actually happened. `transport="drop"`
  appearing in production is not a bug, it is this feature shipping dark; it
  becoming `console` anywhere is impossible by the boot rule. A rising `failed` is
  the page-worthy signal, because nothing else surfaces it: the user already got
  their `202`.
- **`http_request_duration_seconds{route="/api/auth/password-reset"}`** already
  exists via the `onResponse` hook. Its p95 should be flat and unrelated to mail
  latency; if it starts tracking the mail provider, someone has awaited the send.
- One structured log line per non-`requested` outcome:
  `request.log.info({ passwordReset: { outcome } })` — outcome only, never the
  token, the address, or the user id — plus `request.log.error({ err })` when a
  send rejects.
- **Not measured:** delivery, opens, bounces. There is no provider to report them.

## Rollout

**Ships dark in production, by construction rather than by flag.** The endpoints
exist and are correct everywhere, but production runs `MAIL_TRANSPORT=drop` until
a real transport lands, so no mail is delivered and no token can be used. A
separate `PASSWORD_RESET_ENABLED` flag was rejected: it would make the deployed API
surface differ from the committed `openapi.json`, and it would add a branch that
is never exercised in any test environment.

**Order.**

1. **Set `METRICS_TOKEN` on staging and production in Sevalla before merging**
   (at least 32 random characters, different per environment; see "Security
   considerations"). This is a precondition, not a nice-to-have: with
   `NODE_ENV=production` and no token the container refuses to start, which is
   safe — the previous revision keeps serving — but it is an avoidable red deploy.
   Scrapers must then send `Authorization: Bearer <token>`.
2. Set `MAIL_TRANSPORT=drop` on staging and production in Sevalla **before
   merging**. The default is `console`, which throws at boot under
   `NODE_ENV=production` — a merge that lands first fails the staging deploy at
   container start. That is the designed behaviour and it is safe (the previous
   revision keeps serving), but it is an avoidable red deploy.
3. Merge. One PR, one additive migration, applied at container start by
   `scripts/docker-entrypoint.sh` before the server boots. Old instances during
   the rolling deploy ignore both the table and the routes.

The integration helper defaults `MAIL_TRANSPORT` to `drop` and overrides the
mailer per test, and no e2e spec touches these routes. **One CODEOWNERS-protected
workflow does need an environment change**, created by the `/metrics` decision
above: `.github/workflows/nightly.yml` runs the soak app with
`NODE_ENV=production`, so it needs a `METRICS_TOKEN` (any 32+ character literal,
alongside the existing `COOKIE_SECRET`) or the nightly soak fails at container
start. PR CI and the e2e/load jobs are unaffected — they run `NODE_ENV=test`.

**Rollback at 2am.** Redeploy the previous image. Nothing to undo: the table is
inert without the code, outstanding tokens simply expire, and no existing column,
endpoint, or response was modified. There is no runtime off switch by design —
with `drop` in production the feature already delivers nothing, so the only
scenario needing urgency is the confirm route misbehaving, and a rollback removes
it entirely.

**Follow-ups this creates, all already in or added to the backlog:**

- **F-017** — the reset screens and the browser journey (added by this plan).
- **F-005** — the "your password was changed" notification, and the real mail
  transport both features need.
- **F-008** — isolating `/metrics` on its own port or network. Authentication is
  no longer part of it: this PR does that, by review decision.
- **#11** — the `CREATE INDEX CONCURRENTLY` conflict, which this feature routes
  around rather than fixes.

**Diff budget.** Estimated ~465 hand-written lines: migration (~25), schema (~18),
`src/lib/reset-token.ts` (~20), `src/lib/mailer.ts` (~45), `src/routes/auth.ts`
(~85), config and `.env.example` (~20), `src/app.ts` and `src/plugins/metrics.ts`
(~28), `scripts/dump-openapi.ts` and `tests/integration/helpers.ts` (~15), tests
(~210 across unit and integration), plus a regenerated `openapi.json` (generated,
excluded). Under the ~500 guidance. If it runs over, the thing to cut is the
`drop` transport's dedicated test in favour of asserting it inside the metrics
case — never any of the enumeration, replay, expiry, or session-invalidation
cases, which are the feature.
