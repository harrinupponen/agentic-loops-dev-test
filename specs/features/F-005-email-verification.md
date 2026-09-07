# F-005 · Email verification on signup

> Status is tracked in `specs/features.yaml`, not here.

## Problem

Anyone can register with an address they do not control. A typo means the account
owner never receives anything the application sends and cannot recover the account
when they forget their password — F-004 mails a token to an address that is not
theirs. Somebody else's address means that person receives mail about an account
they did not create, and the application has no way to tell the two situations
apart from a real signup.

## Scope

**In scope**

- Issue a verification token when an account is registered, and mail it
- Confirm a token, recording that the address was verified
- Re-issue a token for the signed-in account when the first one is lost or expired
- Expose whether the signed-in account's address is verified

**Out of scope**

- **Enforcing verification anywhere.** Unverified accounts keep full access to
  every endpoint. See `docs/adr/0011-email-verification-is-advisory.md`: with
  `MAIL_TRANSPORT=drop` in production no mail is delivered, so a gate would lock
  out every user on the deploy that shipped it. A `REQUIRE_VERIFIED_EMAIL` flag
  was rejected for the same reason, more explicitly.
- **A real mail transport.** F-004's rollout notes named F-005 as the feature that
  would add one. This plan declines that and moves it to **F-018**, added to the
  backlog here — a provider means a dependency, credentials, templates, an
  `APP_BASE_URL`, and a retry story, and it is not this feature. See "Backlog
  split".
- **The "your password was changed" notification**, also assigned to F-005 by
  F-004's rollout notes. It is a different message on a different trigger and it
  is useless until a transport delivers it; it goes with F-018.
- **A browser screen and a clickable link.** As in F-004, the mail carries a raw
  token and the server accepts it only in a POST body. A URL needs a page and a
  base URL, and both belong to F-018.
- Changing an account's email address, and re-verification when it changes. No
  such endpoint exists.
- Expiring, deleting, or restricting accounts that are never verified.
- Idempotency keys. F-007 kept `POST /api/auth/*` out; nothing here changes that.
- Verifying that the mailbox exists at the SMTP level, disposable-address
  blocklists, and MX checks.

## Design

### API changes

Two new endpoints, plus one changed response body and one changed side effect on
`POST /api/auth/register`. Both new routes are registered unconditionally in every
environment, so the deployed surface matches `openapi.json` everywhere.

| Method | Path                              | Auth        | Notes                                                                                                              |
| ------ | --------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------ |
| POST   | `/api/auth/verify-email`          | **session** | No body. `202` with an empty body. Re-issues and re-sends. Rate limit `AUTH_RATE_LIMIT_MAX`/minute (`authRateLimit`) |
| POST   | `/api/auth/verify-email/confirm`  | none        | Body `{ token }`. `204` on success. Rate limit `AUTH_RATE_LIMIT_MAX`/minute                                        |

`POST /api/auth/register` keeps its `201` and its session cookie, and additionally
issues a verification token and dispatches one message. The response body gains
`emailVerified`.

Resend (`POST /api/auth/verify-email`):

| Situation                                          | Response                             | Side effect                                          |
| -------------------------------------------------- | ------------------------------------ | ------------------------------------------------------ |
| Signed in, unverified, no token issued in the last 60 s | `202`, empty body                | Token row written (replacing any previous), mail sent |
| Signed in, unverified, token issued < 60 s ago     | `202`, empty body                    | **Nothing.** Previous token stays valid, no second mail |
| Signed in, already verified                        | `409 { code: "already_verified" }`   | None                                                  |
| No session, or an expired one                      | `401 { code: "unauthorized" }`       | None                                                  |
| Over the rate limit                                | `429 { code: "rate_limited" }`       | None                                                  |

Confirm (`POST /api/auth/verify-email/confirm`):

| Situation                                | Response                            | Side effect                                          |
| ---------------------------------------- | ----------------------------------- | ------------------------------------------------------ |
| Token exists and is unexpired            | `204`, empty body                   | `users.email_verified_at = now()`, token row deleted |
| Token unknown, already used, or replaced | `400 { code: "invalid_token" }`     | None                                                  |
| Token exists but past `expires_at`       | `400 { code: "token_expired" }`     | None (the transaction rolls back, the dead row stays) |
| Token wrong length or charset            | `400 { code: "validation_failed" }` | None                                                  |
| Over the rate limit                      | `429 { code: "rate_limited" }`      | None                                                  |

Confirm is **public and takes no session**: the link is opened in whatever browser
the mail client hands it to, which is routinely not the one holding the session.
It creates no session either — presenting a mailbox token proves control of the
mailbox, not of the password, and minting a session from it would make it a second
credential. It verifies the account the token was issued for, never the caller's:
a signed-in user A who submits B's token verifies **B**, and A stays unverified.
That is correct — the token is B's proof, not A's — and it is the "other user's
resource" case AGENTS.md requires.

**`emailVerified` is added to the shared `UserView`**, so `register`, `login`, and
`GET /api/auth/me` all carry it. A boolean, not the timestamp: the client needs
the state, and the timestamp is an internal fact with no consumer. The browser
client's `User` interface (`web/src/main.ts`) is structural and ignores the extra
field, so no web change is required and none is made.

**Declared response schemas.** `202`/`204`/`400` follow F-004 exactly, including
the `ErrorResponse` shape with its optional `details` array — the zod serializer
strips undeclared keys, so a `400` schema without `details` silently truncates
every validation error. `409` is declared on the resend route, matching
`POST /api/todos`. `401` is deliberately **not** declared, matching every existing
authenticated route: it is raised by `requireAuth` before validation and no
declared schema means no serializer to strip anything.

### Data model changes

One migration, `drizzle/0004_email_verification.sql`, **purely additive**. Two
statements, no rename, no drop, no backfill. Expand is the whole plan; there is no
contract step.

```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
```

The table is ADR 0009's shape, unchanged — same key, same unique constraint, same
absence of a secondary index and of a retention job, for the same reasons. Both
access paths are served by constraint indexes created with the empty table
(`INSERT ... ON CONFLICT (user_id)`, `DELETE ... WHERE token_hash = $1`), so this
migration adds no `CREATE INDEX` and stays clear of issue #11, exactly as F-004
did.

`email_verified_at` is **nullable with no default and no backfill**. Existing
accounts stay `NULL`, because nobody proved control of those mailboxes and a
column whose contents are partly invented is worse than no column (ADR 0011).
Nullable-no-default also means the `ALTER TABLE` is a catalogue-only change in
Postgres 17: no table rewrite, no long lock, and `migration-safety.mjs` does not
class it as destructive, so it may ship with application code.

Mirrored in `src/db/schema.ts`. `tests/integration/helpers.ts` adds the new table
to the `TRUNCATE` list in `resetDb`.

**Rollback:** the previous image selects neither the column nor the table. The
migration can stay applied through a rollback.

### Configuration

One new key in `src/config.ts`:

```
EMAIL_VERIFICATION_TTL_HOURS   int, min 1, default 24
```

Hours, not minutes: a reset token is used within minutes of being asked for, and a
verification mail is routinely opened the next morning. 24 hours is long enough to
be usable and short enough that a token sitting in an abandoned inbox is stale.

It is a required-with-default field on `Config`, so `scripts/dump-openapi.ts` —
the only place building a `Config` literal — fails typecheck until it is updated.
`.env.example` gains it with a comment.

**No variable becomes required in production**, so **no workflow file changes**.
`nightly.yml`'s soak job runs `NODE_ENV=production` and needs nothing added; this
is the one place where F-004's `METRICS_TOKEN` needed a literal in that env block,
and the difference is that this key has a working default. `MAIL_TRANSPORT` already
exists and is already set on both deployed environments.

### Mail

`Mailer` (`src/lib/mailer.ts`) gains one method beside `sendPasswordReset`:

```ts
sendEmailVerification(message: { to: string; token: string; expiresAt: Date }): Promise<void>;
```

Same signature, same contract, same two transports. `console` prints the address
and raw token to stdout and still refuses to construct under
`NODE_ENV=production`; `drop` resolves without sending, and is what production
runs. No provider, no SDK, no template engine, no `APP_BASE_URL` — the adapter
takes a raw token, the transport composes the message, and there is no page to
link to until F-018.

Adding a method rather than generalising to `send(kind, message)` is deliberate:
the interface names what it can send, so a new kind is a compile error everywhere
it must be handled rather than a string that silently does nothing.

Both call sites dispatch **without awaiting**, per ADR 0010: the send never
changes the response, and its failure is a counter and a log line rather than a
`5xx`. On registration that matters most — a mail provider outage must not fail
signups.

### Token module: the third token type, so the helpers move

`src/lib/reset-token.ts` says, in a comment, that its duplicated
`generate`/`hash` pair "gets lifted into a shared module" if a third token type
appears. This is that third type. The file is renamed to
**`src/lib/recovery-token.ts`** with neutral names — `generateRecoveryToken`,
`hashRecoveryToken`, `RecoveryTokenSchema`, `recoveryTokenExpiry(ttlMinutes)` —
and both flows import from it. Verification passes
`EMAIL_VERIFICATION_TTL_HOURS * 60`, so the expiry helper is unchanged and the
password-reset call sites change by name only. `tests/unit/reset-token.test.ts`
moves with it.

Rejected: duplicating the pair a third time, which is what the comment exists to
prevent, and folding `src/lib/session.ts` in as well — that file is a
CODEOWNERS-protected credential module which F-009 is about to change, and a
session token is not a recovery token.

### Algorithm

**Issue** (shared by registration and resend). Generate a token, hash it, and
claim the account's single slot in one statement:

```sql
INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
VALUES ($1, $2, $3)
ON CONFLICT (user_id) DO UPDATE
  SET token_hash = EXCLUDED.token_hash,
      expires_at = EXCLUDED.expires_at,
      created_at = now()
  -- 60-second per-account cooldown, hard-coded exactly as in password reset:
  -- a property of the design, not a knob.
  WHERE email_verification_tokens.created_at < now() - interval '60 seconds'
RETURNING user_id;
```

A returned row means a new token was issued and the previous one is dead; dispatch
the mail. No row means one was issued within the last 60 seconds: send nothing,
leave the existing token valid, and still reply `202`.

**Registration.** After the existing insert and session creation, issue as above
and dispatch. A conflicting registration (`409 email_taken`) issues nothing and
sends nothing — the second signup attempt on an address must not mail the account
that already owns it, which would let an attacker ping a known address at will.
Neither the issue nor the send is awaited into the response's critical path
beyond the single upsert; a send failure is counted and logged, and the user still
gets their `201` and their session.

**Resend.** `requireAuth`, then read `request.user.emailVerified`; if true, throw
`conflict('already_verified', ...)` before touching the database. Otherwise issue
as above, dispatch, reply `202`.

**Confirm.** Hash the submitted token, then in one transaction:

- `DELETE FROM email_verification_tokens WHERE token_hash = $1 RETURNING user_id, expires_at`
  — deleting *is* the single-use check, one atomic statement, and two concurrent
  confirms cannot both win.
- No row → `badRequest('invalid_token', ...)`; the transaction rolls back.
- `expires_at <= now()` → `badRequest('token_expired', ...)`; rolls back, so the
  dead row survives to be overwritten by the next resend.
- `UPDATE users SET email_verified_at = now(), updated_at = now() WHERE id = $2`
  — unconditional. Re-verifying an account that is already verified is not an
  error here; only a valid live token reaches this line.
- `204`. No session is created, no session is destroyed, no cookie is set or
  cleared. Nothing about a credential changed.

**Session loader.** `createSessionLoader` in `src/plugins/auth.ts` adds
`users.email_verified_at` to its existing select and sets
`request.user = { id, email, emailVerified: row.emailVerifiedAt !== null }`.
`src/fastify.d.ts` gains the field. This is one more column on a query that
already runs, not a second query. It is why `GET /api/auth/me` stays
`(request) => request.user!`.

### Key decisions

See **`docs/adr/0011-email-verification-is-advisory.md`**, plus ADR 0009 (token
shape) and ADR 0010 (mail adapter), both reused unchanged. Summary:

**Verification is recorded and never enforced.** Rejected: gating login or todo
access, which locks out 100% of production users on the deploy that ships it,
because `MAIL_TRANSPORT=drop` delivers nothing. Also rejected, more firmly: a
`REQUIRE_VERIFIED_EMAIL` flag defaulting to off — an authorization branch no
environment executes is proven by nothing, and it turns the most security-relevant
decision in the feature into a setting someone can flip without review. The boot
rule the eventual enforcement feature must carry is written down in ADR 0011 now,
so it is inherited rather than rediscovered.

**Resend is authenticated, so it can be honest.** F-004's request endpoint is
public and therefore must return `202` for every address, known or not, with
matched work on both branches to equalise timing. None of that applies here: the
caller already holds a session, so the response cannot disclose anything they do
not already know, and `409 already_verified` is both truthful and useful.
Rejected: a public `POST /api/auth/verify-email { email }` mirroring the reset
endpoint, which would re-import the entire enumeration problem — and the decoy
branches, the identical-response rules, and the tests that go with it — to serve a
user who, at that moment, is by construction signed in. Registration hands out a
session, and login is not gated on verification precisely so this stays reachable.

**Nothing is backfilled.** Rejected: stamping existing accounts as verified to
"start clean". Nobody proved control of those mailboxes; a column that contains
one invented value can never be trusted for the enforcement decision it exists to
support.

**Consuming a reset token does not also verify the address**, even though it
proves the same thing. Rejected on scope: it couples two flows that are otherwise
independent, it makes password reset's behaviour depend on a column it does not
own, and in production nobody can consume a reset token anyway. Worth revisiting
when F-018 makes both flows live; not worth a surprising side effect now.

**One live token per account, and consuming deletes the row** — ADR 0009,
unchanged. The visible cost is the same one that ADR records: a user who requests
a second mail and then clicks the **first** link is told the link is invalid, and
a user who clicks a link twice gets `400 invalid_token` on the second click even
though their account is fine. Copy on the eventual screen has to say so.

**`emailVerified` on the shared `UserView` rather than a dedicated endpoint.**
Rejected: `GET /api/auth/verify-email/status`, a whole route and round trip for
one boolean the session loader already has in hand.

### Backlog split

F-004's rollout named F-005 as the home for the real mail transport and the
"password changed" notification. This plan declines both and adds **F-018 · Real
outbound mail transport** to `specs/features.yaml`, `deps: [F-004, F-005]`,
`risk_tags: [email, infra, security]`. A provider adapter means a new dependency,
credentials in two environments, an `APP_BASE_URL` and a link format, bounce
handling, and a retry story — none of which is email verification, and all of
which would push this feature past the diff budget on its own.

The consequence is stated plainly rather than buried: **F-005 delivers no
user-visible behaviour in production**, because the mail it sends is dropped and
nothing depends on the answer. What it delivers is a tested flow and a column
that starts filling the day F-018 lands. Same bargain F-004 made, and the same
metric shows it: `mail_messages_total{transport="drop"}`.

## Acceptance criteria

- [ ] `POST /api/auth/register` still returns `201` with a session cookie, writes
      exactly one `email_verification_tokens` row for the new user, and hands the
      injected mailer exactly one `email_verification` message —
      `integration: registration issues a verification token`
- [ ] Registration on an address that already exists returns `409 email_taken`,
      writes no token row, and sends nothing —
      `integration: a duplicate registration does not mail the existing account`
- [ ] Registration still returns `201` with a working session when the mailer
      rejects, and `mail_messages_total{kind="email_verification",outcome="failed"}`
      increments — `integration: a failed verification send does not fail signup`
- [ ] The token handed to the mailer is 43 base64url characters and its sha256
      equals the stored `token_hash`; the raw token is not in the row —
      `integration: stores only the hash of the verification token`
- [ ] Confirming a valid token returns `204`, sets `users.email_verified_at`, and
      `GET /api/auth/me` then returns `emailVerified: true` —
      `integration: consumes a token and marks the address verified`
- [ ] Confirming works with no session at all and sets no cookie in the response —
      `integration: confirming needs no session and creates none`
- [ ] Replaying the same token returns `400 invalid_token` and
      `email_verified_at` keeps its original value —
      `integration: a verification token cannot be used twice`
- [ ] A token past `expires_at` returns `400 token_expired` — a code distinct from
      `invalid_token` — and the account stays unverified —
      `integration: an expired token is rejected with its own code`
- [ ] A syntactically valid but unknown token returns `400 invalid_token` —
      `integration: an unknown verification token is rejected`
- [ ] A token of 42 or 44 characters, or containing `/`, returns
      `400 validation_failed` with a populated `details` array, proving the
      declared `400` schema does not strip it —
      `integration: rejects malformed tokens without truncating the error body`
- [ ] User A, signed in, confirming user B's token verifies **B**; A remains
      unverified and A's session still works —
      `integration: a token verifies the account it was issued for, not the caller`
- [ ] `POST /api/auth/verify-email` without a session returns `401`, writes no
      row, and sends nothing — `integration: resend requires a session`
- [ ] Resend more than 60 s after the previous issue returns `202`, replaces the
      row, sends a second message, and the **first** token is then rejected with
      `400 invalid_token` —
      `integration: resending invalidates the previous token`
- [ ] Resend within 60 s of the previous issue returns `202`, sends **no** second
      message, and leaves the first token usable —
      `integration: a resend inside the cooldown is silently ignored`
- [ ] Resend for an already-verified account returns `409 already_verified`,
      writes no row, and sends nothing —
      `integration: resending for a verified account is refused`
- [ ] `register`, `login`, and `GET /api/auth/me` all return `emailVerified:
      false` for a fresh account and `true` after confirmation —
      `integration: verification state is visible on every user view`
- [ ] An unverified account can log in, create, list, update, and delete todos,
      and can request a password reset — no endpoint gates on verification, which
      is ADR 0011's whole claim —
      `integration: an unverified account keeps full access`
- [ ] No log line produced across register → resend → confirm contains the raw
      token or the email address, at any level, asserted against a captured log
      stream via the existing `logStream` build option —
      `integration: neither the verification token nor the address is ever logged`
- [ ] With `MAIL_TRANSPORT=drop` both routes stay registered and the flow still
      issues and consumes tokens, while
      `mail_messages_total{kind="email_verification",transport="drop"}`
      increments — `integration: the drop transport keeps the flow intact`
- [ ] `/metrics` exposes `email_verification_total` with `outcome` covering
      `issued`, `resent`, `consumed`, `expired`, and `invalid` —
      `integration: exposes email verification counters`
- [ ] `generateRecoveryToken()` returns 43 base64url characters, differs across
      1000 calls, `hashRecoveryToken()` matches sha256 of its input, and
      `RecoveryTokenSchema` rejects 42/44 characters and `+`/`/` —
      `unit: recovery token generation and hashing`
- [ ] `loadConfig` defaults `EMAIL_VERIFICATION_TTL_HOURS` to 24, coerces a string,
      and rejects `0` and a non-integer —
      `unit: loadConfig` email verification TTL cases
- [ ] `openapi.json` documents both new routes with their declared codes and shows
      `emailVerified` on the user view — `npm run openapi:check` fails if the
      checked-in file is stale

## Test plan

| Layer       | Cases                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unit        | `generateRecoveryToken` length, charset, uniqueness across 1000 draws · `hashRecoveryToken` against a known sha256 vector · `RecoveryTokenSchema` accepts 43 and rejects 42/44/`+`/`/`/empty · `recoveryTokenExpiry` arithmetic for `EMAIL_VERIFICATION_TTL_HOURS * 60` · `loadConfig` TTL default, coercion, and rejection                                                                                                                                       |
| integration | happy path (register → confirm → `emailVerified: true`) · **validation failure with `details` preserved** · **unauthenticated: resend returns `401`; confirm is public by design, asserted, and asserted to set no cookie** · **other user's resource: A's session submitting B's token verifies B, not A** · duplicate registration sends nothing · mailer rejection does not fail signup · replay · expiry · unknown token · cooldown · supersede · `409 already_verified` · no endpoint gated on verification · log-content scan · `drop` transport · metrics presence |
| e2e         | **None. Deliberate — same four reasons as F-004**, which apply here unchanged: no browser surface exists; the raw token lives only inside the injected mailer, which is in the integration process; `deploy.yml` runs the whole Playwright suite against `STAGING_URL` where no `DATABASE_URL` exists; and `test-integrity.mjs` forbids the `test.skip` that excluding it would need. The journey belongs with F-018, when a screen and a delivered mail exist. |
| load        | No new k6 scenario. The registration path is already in `load/smoke.js`, and what this adds to it is one indexed upsert and a `drop`-transport call that returns a resolved promise. A scenario would measure the argon2 hash `POST /api/auth/register` already measures. If registration p95 moves after this ships, the existing `http_request_duration_seconds` for that route is where it shows.                                                             |

## Security considerations

**This feature grants no authority, which is the main thing to keep true.** A
verification token cannot log anyone in, cannot change a credential, and cannot
read anything. The worst outcome from a stolen token is that the thief marks
somebody's address as verified — a state on which nothing depends (ADR 0011). That
is the reason confirm can safely be public and unauthenticated. It stops being
true the moment enforcement lands, which is why the enforcement feature gets its
own ADR and its own threat model rather than inheriting this one.

**Token strength and storage.** 256 bits from `crypto.randomBytes`, sha256 in the
database, raw value never persisted — ADR 0009, identical to sessions and reset
tokens. A database leak yields no live tokens.

**User enumeration.** The new surface adds none. Resend is authenticated and only
ever mails the caller's own address; confirm's answers (`invalid_token` /
`token_expired`) are reachable only by someone already holding a token, so neither
says anything about an account. Registration remains the enumeration oracle it
already is by design (`409 email_taken`, F-002), and this feature deliberately
sends **no** mail on that branch — otherwise a stranger could ping a known address
by repeatedly attempting to register it.

**`/metrics` and the F-004 lesson, re-weighed rather than copied.** F-004's
original position was that `mail_messages_total{kind="password_reset"}` is an
enumeration oracle because it moves only for addresses that exist; review then
found `/metrics` publicly reachable and added bearer authentication, which is now
in `src/config.ts` and `src/plugins/metrics.ts` and required in production. Two
things change the calculus here, and both point the same way: the endpoint is no
longer readable without a credential, and `email_verification_total` moves for
registrations and self-service resends, neither of which tells a reader anything
they could not learn from `POST /api/auth/register` directly. **No new counter
label is suppressed, and no new access control is proposed.** `outcome` stays
low-cardinality and carries no address, user id, or transport-derived detail.

**Inbox abuse.** Two mails per address are reachable without a session: none, in
fact — registration mails only the first, successful signup, and everything after
that needs a session for the account. For a signed-in user the 60-second
per-account cooldown lives in the upsert, so it holds across instances and source
IPs unlike the per-IP limiter (in-memory until F-011), bounding a user to mailing
their own address once a minute. That is why this feature does **not** add the
dedicated hourly limit F-004 needed: the reset endpoint is public and mails a
third party, this one is not and does not.

**Argon2 is not on either new path.** Neither route hashes a password, so unlike
password-reset confirm there is no CPU amplifier to bound; `AUTH_RATE_LIMIT_MAX`
covers both routes anyway.

**Logging.** The token and the address are never passed to `request.log` on any
branch at any level. Outcome only, as in password reset. The `console` transport
prints both to stdout and refuses to construct under `NODE_ENV=production`
(ADR 0007, unchanged), so that cannot reach an aggregator. An integration test
scans a captured log stream across a full register → resend → confirm cycle.

**PII.** The address reaches one existing place, the `Mailer`. The new table
stores `user_id` only. `email_verified_at` is one more timestamp on a row that
already holds the address, and `ON DELETE CASCADE` ties the token row to the
account for F-015. `emailVerified` is exposed as a boolean, not a timestamp.

**Sessions.** Confirm neither creates, destroys, nor refreshes a session. The only
change in `src/plugins/auth.ts` is one additional column selected in the existing
session-loading query and one derived boolean on `request.user` — no change to
lookup, expiry, or rejection behaviour. It is called out because that file is
CODEOWNERS-protected and this is the sort of edit that deserves a second pair of
eyes even when it is three lines.

**CSRF.** Both routes are `POST` and are covered by the existing origin hook in
`src/app.ts` wherever `ALLOWED_ORIGINS` is populated. Worth noting for confirm
specifically: an attacker who forges a cross-origin confirm with a token they
already hold achieves what the token already permits, so the exposure is nil.

## Observability

- **`email_verification_total{outcome="issued|resent|consumed|expired|invalid"}`**
  — a new Prometheus counter in `src/plugins/metrics.ts`, passed into
  `registerAuthRoutes` alongside `passwordResets` and `mailMessages` (the
  `Pick<Metrics, ...>` parameter gains it). `issued` fires on registration,
  `resent` on the resend route when a token was actually written — the cooldown
  path increments nothing, so a flat `resent` under a rising `429` rate is
  distinguishable from a broken route. The ratio is the signal: `issued` climbing
  while `consumed` stays at zero is either mail not arriving or nobody being able
  to act on it, and in production today it is the expected reading.
- **`mail_messages_total{kind="email_verification",transport,outcome}`** — reuses
  the existing counter with a new `kind`. `transport="drop"` in production is not
  a bug, it is this feature shipping dark; `console` appearing anywhere in
  production is impossible by the boot rule. A rising `failed` is the page-worthy
  signal once F-018 lands, because the send is not awaited and nothing else
  surfaces it.
- **`http_request_duration_seconds{route="/api/auth/register"}`** already exists.
  Its p95 must not move after this ships: the added work is one indexed upsert.
  If it starts tracking a mail provider's latency, someone has awaited the send.
- One structured log line per non-`issued` outcome —
  `request.log.info({ emailVerification: { outcome } })`, outcome only, never the
  token, address, or user id — plus `request.log.error({ err })` when a send
  rejects.
- **Not measured:** delivery, opens, bounces. There is no provider to report them,
  and inventing a metric that will read zero forever is worse than its absence.

## Rollout

**Ships dark in production, by construction rather than by flag** — and darker
than F-004, because even a delivered token would change nothing an unverified user
can do. `MAIL_TRANSPORT=drop` is already set on staging and production, so no
environment change is needed before merge and there is no ordering hazard of the
kind `METRICS_TOKEN` created.

**Order.**

1. Merge. One PR, one additive migration, applied at container start by
   `scripts/docker-entrypoint.sh` before the server boots. During the rolling
   deploy, old instances select neither the new column nor the new table.
2. Nothing else. No environment variable to set, no workflow to change, no ingress
   or scraper reconfiguration. `EMAIL_VERIFICATION_TTL_HOURS` has a working
   default and is not required in production.

**What a user experiences meanwhile.** Nothing, deliberately, and this is the
question the spec has to answer out loud: a user registers, is signed in
immediately as today, receives no mail because `drop` sends none, and is limited
in no way by being unverified. `GET /api/auth/me` reports `emailVerified: false`
and no client currently renders it. There is no fallback channel and none is
needed, because there is nothing to fall back from — the flow the user cannot
complete also gates nothing. A user who somehow obtains a token (a developer
running `console` locally) can complete verification through the API. When F-018
delivers real mail, this feature starts working with no code change beyond the new
transport.

**Rollback at 2am.** Redeploy the previous image. Nothing to undo: the column is
ignored, the table is inert, outstanding tokens expire on their own, and no
existing endpoint's behaviour or response contract is removed. The one contract
change that survives a rollback is cosmetic in the other direction — the previous
image simply stops returning `emailVerified`, and the browser client never read it.

**Follow-ups this creates:**

- **F-018 · Real outbound mail transport** (added by this plan) — the provider
  adapter, the link format and `APP_BASE_URL`, the password-changed notification
  F-004 assigned here, and the browser screens both mail flows need.
- **Enforcement**, deliberately not scheduled: it needs a product decision and the
  boot rule ADR 0011 specifies (refuse to start when enforcement is on and the
  transport does not deliver). It should not be planned before F-018 exists.
- **#11** — the `CREATE INDEX CONCURRENTLY` conflict, routed around again, not
  fixed.

**Diff budget.** Estimated ~490 hand-written lines: migration (~20), schema (~15),
`src/lib/recovery-token.ts` rename and import updates (~25, mostly moved),
`src/lib/mailer.ts` (~30), `src/routes/auth.ts` (~120),
`src/plugins/auth.ts` and `src/fastify.d.ts` (~10), config and `.env.example`
(~12), `src/plugins/metrics.ts` (~10), `scripts/dump-openapi.ts` and
`tests/integration/helpers.ts` (~4), tests (~240 across unit and integration),
plus a regenerated `openapi.json` (generated, excluded). At the edge of the ~500
guidance, which is why the transport went to F-018 rather than staying here.

If it runs over, cut in this order: fold the dedicated `drop`-transport case into
the metrics case (F-004's own fallback), then drop the duplicate-registration
timing assertions down to the single "sends nothing" assertion. Never cut the
resend route — without it a 24-hour token that expires leaves the user with no
path forward, and the feature becomes a dead end — and never cut the
other-user's-token, replay, expiry, or "unverified account keeps full access"
cases. The last one is the only executable statement of ADR 0011.
