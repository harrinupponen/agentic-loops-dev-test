# F-015 · Data export (GDPR access and portability)

> Status is tracked in `specs/features.yaml`, not here.

## Problem

A user cannot get their data out of this application, and nobody can tell them
what it holds about them. The existing endpoints each answer one product question
through a page-sized window — `GET /api/todos` returns twenty live todos at a
time, `GET /api/auth/sessions` returns up to a hundred sessions, F-014's
`GET /api/auth/audit-events` returns twenty events — and none of them is a copy of
an account. Some of what is stored is not reachable from any route at all: when
the address was verified, when the account row was last updated. So the two
questions a data subject is entitled to ask — "what do you have about me?" (GDPR
Art. 15) and "give it to me in a machine-readable form so I can take it
elsewhere" (Art. 20) — can today only be answered by an operator running `psql`
against production by hand, which is a manual process nobody owns, which leaves no
record that it happened, and which has no guard against handing over the wrong
account's rows.

## Scope

**In scope**

- `GET /api/auth/export`: one request, one response, everything this application
  stores about the **caller** and nobody else
- A **streamed, newline-delimited JSON** document read in bounded batches, so the
  cost of an export is bounded no matter how large the account is
- An explicit, enumerated **allowlist of what the document contains**, and an
  equally explicit list of what it refuses to contain and why
- One new audit action, `account.exported`, so a full extraction of an account is
  visible in the trail F-014 built
- A per-account rate limit tight enough that bulk extraction is not a cheap
  operation, and counters that make a truncated export visible

**Out of scope**

- **Account deletion.** This feature was split during planning; deletion is
  **F-025**, added to `specs/features.yaml` by this plan, `deps: [F-015]`. See
  "Backlog split" for why export ships first and why this is the line to reject on
  if you disagree.
- **A browser surface.** Nothing in the web client links to this endpoint, so
  until a screen exists the export is reachable only by a client that speaks HTTP
  directly — the position F-004, F-009, F-010, F-013 and F-014 each shipped in.
  The screen is deliberately **not** added to the backlog here: a "download my
  data" button and a "delete my account" button belong to one account-settings
  screen, and F-025's plan should own that entry rather than this one creating an
  id it does not design.
- **Asynchronous generation** — a job row, a worker, a stored artefact, a signed
  download link, a "your export is ready" email. Each needs a component this
  project does not have; see [ADR 0026](../../docs/adr/0026-an-export-is-a-stream-with-a-terminator.md).
- **A human-readable format.** No CSV, no HTML, no PDF, no zip archive. Art. 20
  asks for structured, commonly used and machine-readable; NDJSON is all three and
  an archive format is a dependency plus a decompression bomb surface.
- **Exporting anyone else's data**, an operator or admin export, or an export of
  aggregate statistics. There is no admin role in this application and this
  feature does not invent one.
- **Re-import.** The document is an export, not a backup: nothing consumes it.
- **Changing what is stored.** No table, column, index, migration, retention
  window or existing response shape is touched by this feature.

## Design

### API changes

One new endpoint, in a new `src/routes/account.ts`, under the existing `auth`
OpenAPI tag so `src/app.ts`'s tag list is unchanged — the reasoning F-009 and
F-014 both used for their own route files, and with one addition: **F-025 adds
`DELETE /api/auth/account` to this same file**, so the account-lifecycle surface
ends up reviewable in one place rather than appended to a 580-line
`src/routes/auth.ts` that CODEOWNERS already protects.

| Method | Path               | Auth    | Notes                                                                                             |
| ------ | ------------------ | ------- | ------------------------------------------------------------------------------------------------- |
| GET    | `/api/auth/export` | session | The caller's entire account as `application/x-ndjson`, streamed. `200`, or `429` past the budget. |

**No existing route changes at all.** No status code, body, cookie, header, limit
or config key moves anywhere else in the application; `openapi.json` gains one
path. This is the first feature since F-011 that touches neither
`src/routes/auth.ts` nor `src/routes/todos.ts`.

| Situation                      | Response                                    | Notes                                       |
| ------------------------------ | ------------------------------------------- | ------------------------------------------- |
| `GET` with a session           | `200 application/x-ndjson`, streamed        | Always, even for an account with no todos   |
| `GET` without a session        | `401 { code: "unauthorized" }`              | `requireAuth`, unchanged                    |
| `GET` past 5 in the last hour  | `429 { code: "rate_limited" }`              | Per account; see "Rate limiting" below      |
| A batch query fails mid-stream | The connection is closed with no terminator | The status line is already `200`; see below |

Response headers, all three deliberate:

```
content-type:        application/x-ndjson
content-disposition: attachment; filename="agentic-todo-export.ndjson"
cache-control:       no-store
```

`no-store` because this is the single most sensitive response the application
produces and the one most likely to sit in a shared cache, a proxy, or a browser's
back-forward cache. The filename carries **no email address and no user id**: a
file named after its owner leaks that owner to everything that lists a downloads
directory.

### The document

Newline-delimited JSON, one object per line, each line carrying a `type`. It is
**not** a single JSON object and `JSON.parse` on the whole file will fail — that is
the point, and the reasoning is [ADR 0026](../../docs/adr/0026-an-export-is-a-stream-with-a-terminator.md).

```
{"type":"export","format":"agentic-todo.export.v1","exportedAt":"2026-09-15T10:00:00.000Z"}
{"type":"account","id":"…","email":"…","emailVerifiedAt":null,"createdAt":"…","updatedAt":"…"}
{"type":"todo","id":"…","title":"…","completed":false,"createdAt":"…","updatedAt":"…","deletedAt":null}
{"type":"session","id":"…","userAgent":"…","createdAt":"…","expiresAt":"…"}
{"type":"audit_event","id":"…","action":"auth.login","outcome":"success","createdAt":"…"}
{"type":"end","counts":{"todos":1,"sessions":1,"auditEvents":1}}
```

Sections appear in that order; rows within a section are **oldest first**, which is
both the direction the supporting indexes scan and the order an archive reads in.
`format` is one string so that a consumer — or a human opening the file in two
years — can tell what shape this is; it is a version marker, not an extensibility
mechanism, and there is deliberately no envelope, no schema URL and no per-line
metadata beyond `type`.

**The terminator is load-bearing.** Once the first byte is on the wire the status
line is already `200` and no failure can be reported in band. A document whose last
line is not `{"type":"end",…}` is an incomplete export and must be discarded. The
counts are there so a consumer can check what it received rather than trust a byte
count.

### What is exported, and what is refused

Every table in `src/db/schema.ts` is named here. That is the rule ADR 0027
establishes: a table is exported or it is refused **by name**, and a future
migration that adds a table owes the next planner a line in this list.

| Table                       | In the export?                  | Reasoning                                                                                                                                                                      |
| --------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `users`                     | **Yes**, minus `password_hash`  | Identity and account lifecycle. `emailVerifiedAt` is exported as the **timestamp**, not F-002's derived boolean: an export reports what is stored, not what an API view shows. |
| `todos`                     | **Yes**, including soft-deleted | The user's content. Rows in F-010's 30-day trash are still held, so they are still exported, with `deletedAt` set.                                                             |
| `sessions`                  | **Yes**, minus `id`             | Where and when the account has been signed in. `public_id` is exported as `id`, exactly as F-009's list does.                                                                  |
| `audit_events`              | **Yes**, all four columns       | Behavioural data F-014 newly retains for 90 days, and the second thing F-014 promised this feature.                                                                            |
| `password_reset_tokens`     | **No**                          | Refused by name. See below.                                                                                                                                                    |
| `email_verification_tokens` | **No**                          | Refused by name. See below.                                                                                                                                                    |
| `idempotency_keys`          | **No**                          | Refused by name. See below.                                                                                                                                                    |

**`users.password_hash` is never exported.** It is a credential verifier, not
something the user provided in a portable sense, and a file containing an argon2id
digest is an offline cracking target that the user will then store in a downloads
folder, a cloud drive and an email attachment. Refusing it costs the user nothing:
they already know their password, and a hash is not portable to anywhere.

**`sessions.id` is never exported.** It is `sha256(token)` — a verifier for a live
credential (ADR 0014) — and F-009 went to the trouble of adding `public_id`
precisely so the hash never leaves the server. An export is not the place to undo
that.

**Both recovery-token tables are refused.** A row holds a token hash and an
expiry, lives at most 30 minutes (reset) or 24 hours (verification), and is capped
at one per account (ADR 0009). Exporting it would hand out a second credential
verifier in return for the single fact "a reset is pending right now", which the
user already knows because they asked for it and which F-014's
`password_reset.requested` event records in a form that survives the token.

**`idempotency_keys` is refused, and this is the judgement call in this table.**
The row is not obviously infrastructure: `response_body` is a jsonb copy of a todo
this user created, so user content genuinely lives there for 24 hours. It is
refused anyway, for two compounding reasons. First, every byte of it is a
**duplicate** of a `todos` row that the export already contains in full and in its
current state, so including it adds no fact about the user and invites a consumer
to treat a stale copy as a second todo. Second, the key itself is a string the
**client** generated and still holds, and `fingerprint` is a hash of a request the
client sent. Exporting a 24-hour cache of a client's own retries is bookkeeping
noise in a document whose value depends on a user being able to read it. A
reviewer who disagrees should say so: the change is one more section and one more
count, and it is much cheaper to add now than to remove after somebody depends on
it.

### Data model changes

**None.** No new table, no new column, no new index, **no migration file at all**,
and therefore no expand step and no contract step. Stated explicitly rather than
left blank, because it is a decision and not an omission: the alternative design —
an `export_jobs` table holding a status and an artefact location — is what an
asynchronous export needs, and ADR 0026 rejects asynchronous export.

Every read this feature performs is served by an index that already exists:

- `todos` — `todos_user_id_created_at_idx`, scanned forward with a
  `(created_at, id)` keyset predicate
- `sessions` — `sessions_user_id_idx`; a per-account scan of a table whose rows
  are capped in practice by `SESSION_TTL_HOURS`
- `audit_events` — the composite `PRIMARY KEY (user_id, created_at, id)` F-014
  created, scanned forward, which is the same key its own read endpoint scans
  backward
- `users` — the primary key

So this feature **does not touch issue #11 at all**, and that is worth stating
because every feature since F-010 has had to route around it. The constraint is
still live in the code exactly as F-013 and F-014 found it —
`scripts/ci/migration-safety.mjs` still fails any migration containing
`CREATE INDEX` without `CONCURRENTLY` (line 67), and `src/db/migrate.ts` still
wraps every file in `BEGIN`/`COMMIT`, where Postgres refuses
`CREATE INDEX CONCURRENTLY` — while the issue is marked closed as completed. This
design needs no index, so nothing here is blocked; **#11 should still be
reopened**, for the seventh time of asking, before a feature that does need one
trusts it.

### Key decisions

Two ADRs, one decision each:

- **[ADR 0026 · An export is a stream with a terminator, not a document](../../docs/adr/0026-an-export-is-a-stream-with-a-terminator.md)**
  — why NDJSON in bounded batches rather than one JSON object or an async job, and
  what a consumer must do about a missing terminator.
- **[ADR 0027 · An export contains what the user gave us, never what protects it](../../docs/adr/0027-an-export-is-an-allowlist-of-named-tables.md)**
  — the allowlist rule, the four refusals, and the obligation every future table
  inherits.

#### Streamed, in bounded batches — the decision most worth arguing with

The obvious implementation is `SELECT *` per table, assemble one object, `return`
it, and let the zod serializer write it out. It is rejected because **nothing in
this application caps how many todos an account may have.** Three specific
mechanisms turn that into an outage rather than a slow response:

1. `JSON.stringify` of a large object is synchronous and blocks the event loop.
   `@fastify/under-pressure` is configured with `maxEventLoopDelay: 1_000`, so one
   user's export becomes `503`s for every other request on that instance. **One
   authenticated user should not be able to shed load for everybody.**
2. `src/db/client.ts` sets `statement_timeout` and `query_timeout` to 10 seconds.
   A single unbounded `SELECT` against a large account dies at an arbitrary point
   and the user gets a `500` they can do nothing about, forever, on every retry.
3. The pool is `DATABASE_POOL_MAX` (10) connections. Anything that holds one for
   the duration of a download is one tenth of the instance's database capacity
   held hostage by a client's bandwidth.

So: rows are read in **keyset batches of 500** — a constant in the module, not
configuration — each batch is its own statement that returns promptly and releases
its connection, and each row is written to the stream as a line and dropped.
Memory is O(batch), not O(account), and the event loop yields between batches.

The rejected alternatives, in order of how tempting they are:

- **Cap the export at N rows and set `truncated: true`.** An incomplete export
  presented as an export is worse than no export: it satisfies neither Art. 15 nor
  Art. 20 while looking like it does.
- **An async job: a row, a worker, an artefact, an email with a link.** This is
  what most applications do and it needs three things this one does not have — a
  scheduler or queue (there is none, and ADR 0017 is the standing decision not to
  add one), somewhere to put a multi-megabyte artefact (Sevalla provisions two
  Postgres databases and nothing else, per `docs/deployment-sevalla.md`), and a
  mail transport that sends anything (`MAIL_TRANSPORT=drop` until F-018 ships). It
  would also invent a new security surface — a link that grants access to an
  account's entire contents — which is a bigger decision than this feature.
- **`pg-query-stream` or a JSON streaming library.** A new dependency, which
  `AGENTS.md` rule 7 makes a human review, to replace a ten-line keyset loop this
  codebase already writes in four other places.
- **`REPEATABLE READ` around the whole export, for a consistent snapshot.** This is
  the one rejection with a real cost, and it is in ADR 0026: a transaction held
  open for as long as the slowest client takes to read pins a pool connection and
  blocks vacuum from removing dead tuples across the whole database for that
  duration. The accepted consequence is that **the export is not a point-in-time
  snapshot** — a todo created while the stream runs may or may not appear, and one
  deleted while it runs may vanish between sections. `exportedAt` is the time the
  export started, and it is the only consistency claim made.

#### One new audit action, and why the closed set opens for this one

`account.exported` joins the `AuditAction` union in `src/lib/audit.ts`. ADR 0025
closed the set at seven actions but made the extension path explicit: a new action
is a TypeScript change, not a migration, precisely so that a future security
feature is not tempted to skip the event. This qualifies on the terms that ADR set
out — it is a **credential-lifecycle-grade event on the account itself**, not a
product operation: a single request that extracts everything the application knows
about an account is the most valuable thing an attacker holding a stolen cookie can
do, and the whole point of F-014 is that such a thing leaves a mark the attacker
cannot erase.

Two consequences, both stated rather than discovered:

- **The row is written before the first byte, not after the stream completes.**
  The security-relevant fact is "somebody asked for a complete copy of this
  account", which is true whether or not the transfer finished, and after the
  stream has started nothing can be reliably awaited. `outcome` is `success`,
  meaning the request was authorized and the stream began; whether the download
  completed is `account_exports_total`'s job, not the audit log's.
- **An export never contains its own audit row.** The write happens before the read
  of `audit_events`, but the rows are streamed in one query per batch, so whether
  the new row appears is a race; the specification is that the reader must not
  assume either way, and no acceptance criterion asserts it. The next export will
  contain it.

Per ADR 0024 the write is awaited, wrapped in `try`/`catch`, and **never fatal** —
a failed audit write must not deny a user their data.

#### No password re-authentication, deliberately

`POST /api/auth/password-reset/confirm` proves possession of a mailbox and
F-025 will require the password again before destroying an account. This endpoint
requires neither, and the reason is narrow enough to state precisely: **the export
reaches nothing that the session holding it does not already reach.** An attacker
with a stolen cookie can already page `GET /api/todos` (live and trash),
`GET /api/auth/sessions` and `GET /api/auth/audit-events` and assemble the same
document by hand. The export makes that convenient; it does not make it possible.
Re-authentication here would buy a delay measured in one extra HTTP request and
would cost the endpoint its shape — a password in a body makes it a `POST`, which
makes it unlinkable and unbookmarkable for the legitimate user with no security
gain. F-025 is the opposite case and will be argued the opposite way: deletion is
irreversible and reaches something a session alone does not.

What does apply, and is the actual mitigation, is the rate limit below plus the
audit row above: bulk extraction is slow and it is recorded.

#### Rate limiting: 5 per hour, per account, hard-coded

A route-level `config.rateLimit` of `{ max: 5, timeWindow: '1 hour' }`. The global
limiter's key generator is already `request.user?.id ?? request.ip` and the session
loader runs at `onRequest` before the limiter's own hook, so this is **per
account**, which is what matters for an endpoint that is only reachable with a
session.

Hard-coded rather than a new environment variable, the same call
`src/routes/auth.ts` makes for its 60-second per-account token cooldown: it is a
property of the design rather than a knob. Nobody needs six copies of their
account in an hour, and F-011's spec records that `agentic-todo-staging` has
`RATE_LIMIT_MAX` and `AUTH_RATE_LIMIT_MAX` overridden to `100000` as Sevalla
environment variables so the Playwright suite can run — an `EXPORT_RATE_LIMIT_MAX`
would be the third value that can be quietly set to a number that disables the
control, on the one endpoint where the control is the mitigation.

#### Why `GET /api/auth/export` rather than a new namespace

`/api/auth/*` is already where everything about an account lives — sessions,
audit events, verification, reset — and a new `/api/account/*` prefix would need a
new OpenAPI tag and would put two halves of the account surface in two namespaces.
It is a `GET` because it is a read, which keeps it usable from a browser's address
bar and from `curl` without a body, and which keeps it outside the CSRF origin hook
that only inspects state-changing methods. That is safe here for the reason stated
under "Security considerations": a cross-origin page can cause the browser to
_fetch_ this URL but cannot _read_ the response, because the application sets no
CORS headers at all.

### Backlog split

At ~470 hand-written lines (budget below) the export alone is at the guidance, and
the original F-015 — "account deletion **and** data export" — was two independent
server features in one entry, each with its own irreversible edge. It is split:

**F-025 · Account deletion (GDPR erasure)** is added to `specs/features.yaml`,
`deps: [F-015]`, `risk_tags: [pii, security, legal, auth]`, with a stub spec.
F-015 keeps the export.

**Export ships first, and that ordering is the line to reject on.** The argument
is that shipping irreversible erasure before a user can retrieve anything is the
wrong order to take risk in: a user who deletes their account on the day deletion
ships and then asks for their data gets nothing, forever, and there is no rollback
for that anywhere in the system. Reversed, the worst case is a user who can copy
their data and must wait for the button that destroys it. The dependency is
recorded as `deps: [F-015]` rather than left as two independent entries so the
ordering survives this PR. If you disagree — if the erasure obligation is the
urgent one — say so on the issue and both entries can be re-planned in the other
order; what should not happen is the two being merged back into one feature, which
is how the budget got here.

Notes for F-025, which are **notes and not decisions for it**:

- Deletion needs **no new table and no soft-delete column**. Every table that
  references `users` does so with `ON DELETE CASCADE`, so one `DELETE FROM users`
  removes sessions, todos, idempotency keys, both token tables and the audit trail
  in one statement. F-014 made `audit_events.user_id` `NOT NULL` for exactly this.
- **A grace period cannot be implemented with the mechanism this codebase has.**
  ADR 0017's sweep is caller-scoped and runs on the request path of the account
  that produced the rows — and a deleted account makes no further requests, so
  nothing would ever sweep a deferred deletion. A grace period means a scheduler,
  which means superseding ADR 0017.
- **The account's audit trail dies with it**, including the `account.deleted` row
  it would otherwise write. That is worth deciding explicitly rather than
  discovering: an audit action whose row is destroyed by the operation it records
  is not an audit action.
- Deletion **frees the email address** for re-registration, because `users.email`
  is unique and the row is gone. Whether that is desirable is F-025's call.
- It should require the password again, for the reason this feature does not.

## Acceptance criteria

- [ ] `GET /api/auth/export` returns `200` with
      `content-type: application/x-ndjson`,
      `content-disposition: attachment; filename="agentic-todo-export.ndjson"` and
      `cache-control: no-store`, and the filename contains neither the email
      address nor the user id —
      `integration: the export is served as a no-store ndjson attachment`
- [ ] Every line of the body parses as JSON on its own, the first line is
      `{"type":"export","format":"agentic-todo.export.v1",…}` and the last is
      `{"type":"end",…}` — `integration: the export is newline-delimited json between a header and a terminator`
- [ ] For an account with two todos (one soft-deleted), one session and its
      registration audit event, the document contains exactly one `account` line,
      two `todo` lines including the deleted one with a non-null `deletedAt`, one
      `session` line and at least one `audit_event` line, and `end.counts` equals
      the number of lines of each type actually emitted —
      `integration: exports todos including the trash, sessions and audit events`
- [ ] **The raw body contains no `passwordHash`, no `password_hash`, no
      `tokenHash`, no `fingerprint` and no `responseBody` key**, and does not
      contain the sha256 of the caller's live session token, asserted against the
      raw serialised body after issuing a reset token, a verification token and an
      idempotent create so all three refused tables have rows —
      `integration: the export refuses credentials and the refused tables`
- [ ] **Bob's export contains none of Alice's rows**: with both accounts holding
      todos, sessions and audit events, Bob's export contains no todo title, todo
      id, session public id, audit event id or email belonging to Alice —
      `integration: the export never crosses accounts`
- [ ] An account with no todos still returns `200` with a header line, an
      `account` line, a terminator and `counts.todos === 0` — not a `404` and not
      an empty body — `integration: an empty account still exports a valid document`
- [ ] With more than one batch of todos (`EXPORT_BATCH_SIZE + 1` rows, the
      constant exported for the test), every row appears exactly once, in
      ascending `createdAt` order, with no duplicate at the batch boundary —
      `integration: the export pages across batch boundaries without gaps or duplicates`
- [ ] `GET /api/auth/export` without a session returns `401` and no body content
      from any account — `integration: the export requires authentication`
- [ ] A sixth export within an hour returns `429 { code: "rate_limited" }` and
      emits no document, while a different account's first export in the same
      window still returns `200` —
      `integration: the export budget is five per hour and per account`
- [ ] One `audit_events` row with `action='account.exported'`,
      `outcome='success'` is written per successful export, owned by the caller,
      and it is visible in `GET /api/auth/audit-events` afterwards —
      `integration: an export is recorded in the audit trail`
- [ ] An export whose audit write fails still returns `200` and a complete
      document, and `audit_write_failures_total` advances by one —
      `integration: an unwritable audit table does not deny a user their data`
- [ ] `/metrics` exposes `account_exports_total` with `outcome` covering
      `started` and `completed`, and `account_export_duration_seconds` —
      `integration: exposes export counters`
- [ ] No log line produced by an export contains an email address, a todo title, a
      session token or hash, or a user agent, asserted against a captured log
      stream via the `logStream` build option —
      `integration: the export logs no identifiers and no content`
- [ ] The pure row-to-line mappers emit exactly the allowlisted keys for each
      type: given a full database row including `passwordHash` / `id` (the session
      hash), the emitted object has neither —
      `unit: the export mappers emit only allowlisted keys`
- [ ] `openapi.json` documents `GET /api/auth/export` with its `200` as
      `application/x-ndjson` and its `429`, and the route is not hidden —
      `npm run openapi:check` fails if the checked-in file is stale

## Test plan

| Layer       | Cases                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unit        | **`tests/unit/account-export.test.ts`.** Unlike F-013 and F-014 there is genuine pure logic here and it carries the feature's main security property: the row-to-line mappers. One case per type, each fed a complete database row (including `passwordHash` on the user and `id` — the token hash — on the session) asserting the emitted object's key set exactly, so a future `select()` that stops projecting columns cannot leak one. Plus the line encoder: every emitted line ends in `\n` and contains no raw newline, against a todo title containing `\n` and `"`.                                                                                                                                                    |
| integration | **A new `tests/integration/account-export.test.ts`.** **happy path** (a populated account, every section, terminator, counts) · **validation failure** (none to have — there is no query string; the `429` case stands in its place) · **unauthenticated** (no cookie) · **other user's resource** (Bob's export over Alice's fully populated account — the case that matters most) · the credential and refused-table body scan · the empty account · the multi-batch boundary · the rate-limit budget including a second account · the audit row · the audit-write-failure injection (rename `audit_events` in a `try`/`finally`, as F-014's suite already does) · the three response headers · a log-stream scan · counters. |
| e2e         | **None, deliberately.** There is no browser surface, so an e2e would be a `request.get()` duplicating the integration suite at the cost of a container boot — the argument F-004, F-008, F-009, F-010, F-013 and F-014 each made. It is sharper here: `deploy.yml` runs Playwright against `STAGING_URL`, and an export e2e would pull a full copy of a staging account over the network on every deploy and write an `account.exported` row into a deployed environment each time.                                                                                                                                                                                                                                             |
| load        | **No new k6 scenario and no new threshold.** The endpoint is capped at 5 requests per hour per account, so a k6 scenario against it would measure the rate limiter rather than the export — every virtual user shares one account or registers a fresh one with nothing in it. The property that actually needs proving under load is the negative one (an export must not shed load for everyone else), and the honest way to prove that is a manual run against staging with a seeded large account, recorded in the rollout watch list below rather than pretended at in CI.                                                                                                                                                 |

## Security considerations

**This is the highest-value response the application produces, and that is the
whole threat model.** One authenticated request returns every todo, every session,
the complete audit trail and the account record. The controls, in the order they
apply:

- **Authentication and scoping.** `requireAuth`, and every one of the four queries
  carries `user_id = request.user!.id` in its `WHERE` — never a fetch followed by
  an ownership check. There is no id, no cursor and no query parameter anywhere in
  this endpoint's surface, so there is no input an attacker can vary to widen it:
  the account is taken from the session and nothing else. This has its own
  acceptance criterion against a fully populated second account.
- **Rate limiting**, 5 per hour per account, hard-coded so no environment can set
  it to 100000 (F-011 records that staging has done exactly that to two other
  limits).
- **The audit row**, written before the first byte, which the holder of a stolen
  session cannot subsequently erase — F-014 ships no update or delete path on that
  table reachable from any route. This is the control that turns a silent bulk
  extraction into something the account's owner can see afterwards.

**What an attacker with a stolen session cookie gains: speed, not reach.** Every
byte in the document is already reachable through `GET /api/todos` (live and
`?deleted=true`), `GET /api/auth/sessions` and `GET /api/auth/audit-events` by
anyone holding that cookie. This is why the endpoint does not re-authenticate, and
it is the assumption to check if you disagree with that decision: the claim is that
the export adds convenience to an attacker who has already won, and adds a
recorded, rate-limited, single-request path where there was an unrecorded,
loosely-limited, many-request one. `emailVerifiedAt` and `users.updatedAt` are the
only two facts in the document not otherwise reachable, and neither is a secret.

**Credentials are refused by construction, not by care.** The four refusals —
`password_hash`, `sessions.id`, both token-hash tables — are enforced by the
explicit column projection in each query and by the pure mappers, both of which
have their own tests. The document is assembled from named columns; there is no
`select()` of a whole row anywhere in this feature, which is what makes "a future
schema column cannot appear in an export by accident" true rather than hoped for.

**No cache, anywhere.** `cache-control: no-store` on the response. This endpoint
has nothing to do with F-012's Redis list cache — it does not read it, does not
write it, and does not share a key with it — and that stays true because F-012
caches only `GET /api/todos` with no cursor.

**CSRF and cross-origin reads.** It is a `GET`, so `src/app.ts`'s origin hook does
not inspect it, and that is correct rather than an oversight: the application sets
**no CORS headers at all**, so a cross-origin page can cause a browser to request
this URL but cannot read a byte of the response, and helmet's CSP sets
`connect-src 'self'`. The residual is that a malicious page can make a victim's
browser download a file the victim already owns, which is a nuisance and not a
disclosure.

**Logging.** Counts, durations and outcomes; never a title, never an address,
never a user agent, never a line of the document. The log-stream assertion F-009,
F-010, F-013 and F-014 each shipped applies here and matters more, because this is
the one handler that has every sensitive value in the application in local
variables at once.

**New personal data collected: none.** No new column, no new retention window,
nothing newly stored. What changes is **reachability**: data that was spread across
four paginated endpoints becomes one file that will be emailed, copied to a laptop
and uploaded to another service — which is precisely what Art. 20 asks for and
precisely why `no-store`, the neutral filename and the audit row are in this
design.

## Observability

- **`account_exports_total{outcome}`** — a new Prometheus counter in
  `src/plugins/metrics.ts`, `outcome` ∈ `started` | `completed` | `failed`. Two
  labels for one request, deliberately: `started` increments before the first byte
  and `completed` after the terminator is written, so **`started` minus
  `completed` is the number of exports that died mid-stream** — the one failure
  ADR 0026 makes invisible to the HTTP status code, since it is already `200` by
  then. `failed` increments when a batch query throws, which distinguishes "the
  server broke" from "the client hung up". Three series, no user id and no email
  as a label.
- **`account_export_duration_seconds`** — a histogram over the whole stream,
  bucketed like `todo_search_duration_seconds` so the two read the same way. It
  measures what `http_request_duration_seconds{route="/api/auth/export"}` cannot
  measure honestly: that histogram observes `reply.elapsedTime`, which for a
  streamed response includes the client's download time, so a user on a slow link
  is indistinguishable from a slow query. This series is the one that says whether
  the batching decision held up, and a p95 rising while the row counts are flat
  means the batch loop is the suspect.
- **`audit_events_total{action="account.exported"}`** — F-014's counter, one new
  series, free. **A sustained rise across the population is a credential-stuffing
  campaign harvesting accounts**, and it is the counter most worth an alert rule
  when F-019 gives it somewhere to fire: nobody exports their account twice a week,
  so the population rate should be near zero and boring.
- **One `info` log line per export**, `{ export: { outcome, todos, sessions,
auditEvents, ms } }` — counts and a duration, never content. It is what makes a
  support conversation ("I downloaded my data and it looks empty") answerable
  without touching the database.
- **Not measured:** the byte size of the document. It would mean counting bytes
  through the stream for a number that `counts` already implies, and it is the one
  value that most closely tracks the content of a specific user's account.

## Rollout

**No feature flag, no configuration, no migration.** One new route registered
unconditionally; the batch size, the rate limit and the format string are constants
in the module. There is no new environment variable to set before merging and no
`docs/deployment-sevalla.md` change. The deployed contract matches `openapi.json`
in every environment, the position every server feature since F-004 has taken.

**Order.** Merge. Nothing to apply, nothing to backfill, nothing to enable.

**During the rolling deploy both versions are correct.** Old instances return
`404` for the route for the length of the rollout; new instances serve it. No
existing request changes behaviour on either, because no existing code path is
touched. The one visible artefact is that `src/lib/audit.ts` gains an action that
older instances have never written — harmless in both directions, because F-014
deliberately declared `action` as `z.string()` on the wire rather than an enum
precisely so an older instance serving `GET /api/auth/audit-events` cannot `500`
on a value a newer one wrote.

**Rollback at 2am.** Redeploy the previous image. The route vanishes, no schema
changed, no data was written except `audit_events` rows whose `action` an older
instance will serve as an opaque string without complaint, and no session, token,
todo or limit was modified. There is nothing to undo.

**What to watch after deploying, in order:**

1. `account_exports_total{outcome="started"}` versus `{outcome="completed"}`. They
   should track one for one. A persistent gap means exports are dying mid-stream
   and nobody is getting a complete file — the failure mode ADR 0026 accepts and
   this counter exists to surface.
2. `account_export_duration_seconds` p95, and the event-loop lag already exported
   by `collectDefaultMetrics` (`nodejs_eventloop_lag_seconds`) on the instance
   serving it. The claim being tested is that a large export does not raise lag;
   if it does, the batch size is the first thing to cut.
3. `account_exports_total{outcome="failed"}` against
   `http_request_duration_seconds{route="/api/auth/export"}`. A failure at 10
   seconds is the pool's `statement_timeout`, which means a batch query has
   outgrown its budget.
4. `audit_events_total{action="account.exported"}` across the population. It should
   be near zero and flat; a step change is either a bug or a campaign.
5. **One manual run against staging with a seeded large account** (≥ 50 000 todos)
   before the production approval, recorded in the PR. This is the assertion CI
   deliberately does not make, and it is the one that proves the central decision.

**Follow-ups this creates:**

- **F-025 · Account deletion** (added by this plan), `deps: [F-015]`. Until it
  ships, a user can obtain their data but not erase it, which is half of the GDPR
  obligation and is stated plainly rather than implied.
- **An account-settings screen** — a "download my data" link and, later, the
  delete button. Deliberately **not** added to the backlog here; F-025 should own
  that entry, because one screen serves both and creating the id now would mean
  designing a screen for a button that does not exist yet.
- **#11 should be reopened.** Not blocking here — this feature adds no index and no
  migration — but the conflict is still in the code while the issue says otherwise.
- **No contract migration is owed**, because no migration ships at all.

**Diff budget.** Estimated ~470 hand-written lines: `src/routes/account.ts` (~150,
roughly half comment at this codebase's density), `src/lib/audit.ts` (~2, one union
member), `src/plugins/metrics.ts` (~18), `src/app.ts` (~4), unit tests (~60),
integration tests (~235), plus a regenerated `openapi.json` (generated, excluded).
At the ~500 guidance, which is why F-025 exists rather than a deletion endpoint in
this PR. If it runs over, cut the multi-batch boundary case to a smaller constant
and cut the header assertions — **never** the cross-account case, the
credential-refusal body scan, or the mapper key-set unit tests, which are this
feature's entire security argument.
