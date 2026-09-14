# F-014 · Audit log for security-relevant events

> Status is tracked in `specs/features.yaml`, not here.

## Problem

A user has no way to find out what has happened to their account. F-009 lets them
see which sessions exist **right now** and end the ones they do not recognise, but
a session that was created and revoked last Tuesday leaves no trace at all, and
neither does a password reset somebody else requested against their address, nor
four hundred failed sign-in attempts against their password. The question every
compromised-account conversation starts with — "when did this happen, and what
else did they do?" — is currently unanswerable, by the user and by an operator
alike. The structured logs cannot answer it either, and deliberately so: F-004,
F-005, F-009 and F-013 each log an outcome and a count and explicitly no
identifiers, nothing scrapes or stores those lines anywhere (F-019 is unbuilt, so
there is no log backend at all), and a log line is not a per-account record a user
can be shown.

## Scope

**In scope**

- An append-only `audit_events` table, one row per security-relevant event, owned
  by the account the event happened to
- Recording a **closed, enumerated set of seven events** on the credential and
  session lifecycle — registration, sign-in success, sign-in failure, password
  reset requested, password reset completed, one session revoked, all other
  sessions revoked
- `GET /api/auth/audit-events`, so a user can read **their own** trail, newest
  first, through the same keyset cursor every other list in this application uses
- A retention window, enforced the way ADR 0017 already requires — a bounded,
  caller-scoped, best-effort sweep on the request path that produces the rows
- Counters that make both the recording and the retention visible in production,
  including the counter that says the log has holes

**Out of scope**

- **Recording anything about todos.** Creating, editing, deleting and restoring a
  todo are not security events; they are the application. F-010's counters already
  cover them, and putting them here would multiply the table's write volume by the
  product's entire traffic for no security value.
- **Email verification events.** Deliberately excluded rather than forgotten:
  nothing in this application authorizes on verification (ADR 0011), so issuing or
  consuming a verification token changes no one's access to anything. Recording
  advisory state in a security log dilutes it.
- **A free-form `details jsonb` column**, or any per-event metadata beyond the
  four columns in "Data model changes". This is the single most likely
  gold-plating direction and it is refused by name in
  [ADR 0025](../../docs/adr/0025-the-audit-log-records-a-closed-set-of-events.md).
- **IP addresses, geolocation, user agents, email addresses, request bodies.**
  ADR 0015 rejected storing a location on a session and named this feature as the
  likelier home for it. The answer is still no; see "Key decisions".
- **Tamper evidence** — hash chaining, signatures, append-only enforcement by
  database grants, or a write-once external store. See "Key decisions" for what is
  and is not claimed.
- **An operator or admin view across all accounts.** There is no admin role in
  this application, and inventing one here would be a bigger feature than this
  one. Aggregate operator signal arrives as metrics, not as a query surface.
- **Alerting on audit events.** F-019 owns dashboards and a metrics backend;
  nothing here can page anyone because nothing scrapes `/metrics` yet.
- **Browser screens.** No screen reads this API. **F-024**, added to the backlog
  by this plan, owns the account activity screen and the browser journey. See
  "Backlog split".
- **Exporting or deleting the trail on request.** That is F-015, which depends on
  this feature. Deletion is already handled by the foreign key cascade; export is
  one more table for F-015 to read.

## Design

### API changes

One new endpoint, in a new `src/routes/audit.ts`, under the existing `auth`
OpenAPI tag so `src/app.ts`'s tag list is unchanged. Same reasoning F-009 used for
`src/routes/sessions.ts`: `src/routes/auth.ts` is already ~500 lines and
CODEOWNERS-protected, and this feature's surface should be reviewable on its own.

| Method | Path                               | Auth    | Notes                                                                                                  |
| ------ | ---------------------------------- | ------- | ------------------------------------------------------------------------------------------------------ |
| GET    | `/api/auth/audit-events`           | session | The caller's own events, newest first, keyset paginated. `200 { items, nextCursor }`.                  |
| POST   | `/api/auth/register`               | none    | Unchanged contract. Now **records** `auth.register` after the session is created.                      |
| POST   | `/api/auth/login`                  | none    | Unchanged contract. Records `auth.login` `success`, or `failure` **when the address is known**.        |
| POST   | `/api/auth/password-reset`         | none    | Unchanged contract (still always `202`). Records `password_reset.requested` when the address is known. |
| POST   | `/api/auth/password-reset/confirm` | none    | Unchanged contract. Records `password_reset.completed`.                                                |
| DELETE | `/api/auth/sessions/:id`           | session | Unchanged contract. Records `session.revoked`.                                                         |
| DELETE | `/api/auth/sessions`               | session | Unchanged contract. Records `session.revoked_others`.                                                  |

**No existing request or response shape changes anywhere.** Every status code,
body and cookie behaviour on the six existing routes is exactly what it is today;
the only difference is a row written after the work is done. `openapi.json` gains
one path and nothing else.

`AuditEventView`, the only representation:

```ts
{
  id: string; // uuid — the row's own id, not a session id and not a user id
  action: string; // e.g. 'auth.login'. A string, NOT a zod enum — see below.
  outcome: string; // 'success' | 'failure'. Also a string, for the same reason.
  createdAt: Date;
}
```

`ListQuery`, copied from `src/routes/todos.ts` rather than reinvented:

```ts
limit: z.coerce.number().int().min(1).max(100).default(20),
cursor: z.coerce.date().optional(),
```

| Situation                              | Response                              | Notes                                     |
| -------------------------------------- | ------------------------------------- | ----------------------------------------- |
| `GET` with a session and some events   | `200 { items, nextCursor }`           | `created_at DESC`, the caller's rows only |
| `GET` with a session and no events     | `200 { items: [], nextCursor: null }` | Not a `404`                               |
| `GET ?limit=0` or `?limit=101`         | `400 { code: "validation_failed" }`   | zod, before the handler                   |
| `GET ?cursor=not-a-date`               | `400 { code: "validation_failed" }`   | Same coercion the todo list uses          |
| `GET` with another user's cursor value | `200`, the caller's own older rows    | A cursor is a timestamp, not a permission |
| `GET` without a session                | `401 { code: "unauthorized" }`        | `requireAuth`, unchanged                  |

**`action` and `outcome` are declared as `z.string()`, not `z.enum()`, and that is
deliberate.** The set of actions grows every time a future feature adds a security
surface. A declared enum would make the read endpoint a **rolling-deploy hazard**:
during a deploy a new instance writes `some.new.action`, an old instance serves the
list, and the zod response serializer — which validates as well as strips — turns
one unknown string into a `500` on a route whose entire job is to be readable
during an incident. The closed set is enforced where it can be enforced safely, in
the TypeScript union that the writer accepts (`src/lib/audit.ts`); the values are
documented in the OpenAPI description rather than in the schema. This also removes
any temptation to put a `CHECK` constraint on the column — see "Data model
changes".

### The events

Seven actions, each written at exactly one call site. This is the whole list; the
argument for the boundary is in
[ADR 0025](../../docs/adr/0025-the-audit-log-records-a-closed-set-of-events.md).

| Action                     | Outcome   | Written at                                                                  | Why a user needs it                                                                            |
| -------------------------- | --------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `auth.register`            | `success` | `POST /api/auth/register`, after `createSession`                            | "This account was created at T" — the first row of every trail                                 |
| `auth.login`               | `success` | `POST /api/auth/login`, after `createSession`                               | "Somebody signed in as me at T, from a session I can now see in F-009's list"                  |
| `auth.login`               | `failure` | `POST /api/auth/login`, **only when the email matched an account**          | The single highest-value row in this feature: somebody is guessing this account's password     |
| `password_reset.requested` | `success` | `POST /api/auth/password-reset`, **only when the email matched an account** | "Somebody asked to reset my password and I did not" — reaches a victim who never sees the mail |
| `password_reset.completed` | `success` | `POST /api/auth/password-reset/confirm`                                     | The credential changed, and every session died with it                                         |
| `session.revoked`          | `success` | `DELETE /api/auth/sessions/:id`                                             | Closes F-009's loop: the revocation outlives the session row                                   |
| `session.revoked_others`   | `success` | `DELETE /api/auth/sessions`                                                 | "Everything was signed out at T" — answerable months later                                     |

**A failed sign-in against an address that matches no account writes no row**, and
that is a deliberate, load-bearing decision rather than an oversight. There is no
account to own the row, so nobody could ever read it; the only way to make it
meaningful would be to store the attempted address, which would build a table of
email addresses belonging to people who are **not** users of this service — a
worse privacy position than the one this feature is trying to improve. The
residual cost is stated in "Security considerations" under the enumeration-timing
heading, because it is the one place this design is asymmetric between the known
and unknown branches, and it is the first thing a reviewer should push on.

**`POST /api/auth/logout` records nothing**, after consideration. The user pressed
the button, on the device in their hand, one second ago; the event has no reader.
`session.revoked` covers the case that actually matters — a session ended by
someone who was not using it.

### Data model changes

One migration, `drizzle/0007_audit_events.sql`. **One new table, nothing else
touched.** Purely additive under `scripts/ci/migration-safety.mjs` rule 2, so it
ships legally alongside `src/` changes, and it stays applied through a rollback
because the previously deployed image never reads it.

```sql
CREATE TABLE IF NOT EXISTS audit_events (
  -- Not the primary key on its own; see the composite key below.
  id         uuid NOT NULL DEFAULT gen_random_uuid(),
  -- NOT NULL, deliberately: every row has an owner who can read it, and the
  -- cascade is what makes F-015's account deletion complete for free.
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- A closed set enforced in TypeScript, NOT by a CHECK constraint. Adding an
  -- action later must not require dropping and recreating a constraint, which
  -- migration-safety.mjs (rightly) classes as destructive and forces into its
  -- own PR. See the spec's "API changes".
  action     text NOT NULL,
  outcome    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Both access paths are served by this key and this migration therefore adds
  -- no index: the read endpoint is
  -- `WHERE user_id = $1 [AND created_at < $cursor] ORDER BY created_at DESC`,
  -- served by a backward scan on the leading two columns, and the retention
  -- sweep uses exactly the same prefix. `id` is the tie-break, because `now()`
  -- is constant within a transaction and two events must never collide.
  -- The same shape idempotency_keys (0002) and password_reset_tokens (0003)
  -- use, and the same reason: a standalone CREATE INDEX is unavailable here
  -- (issue #11) and unnecessary anyway.
  PRIMARY KEY (user_id, created_at, id)
);
```

Mirrored in `src/db/schema.ts` as `auditEvents`, with the composite primary key
declared through `primaryKey({ columns: [...] })` exactly as `idempotencyKeys`
does. `resetDb` in `tests/integration/helpers.ts` gains `audit_events` in its
`TRUNCATE` list.

**Expand / contract, stated explicitly** (ADR 0003): **there is an expand step and
there is no contract step, now or ever.** The table is created with every column
it needs, all `NOT NULL`, all with their final types. Nothing is backfilled,
nothing is later made `NOT NULL`, nothing is dropped. This is the same position
`idempotency_keys` and both recovery-token tables shipped in, and unlike F-009's
`public_id` it leaves no follow-up migration owed.

**No index, and no `CREATE INDEX` statement anywhere in the migration.** Two
independent reasons, and the order matters:

1. **None is needed.** The composite primary key _is_ the index for both queries.
   Postgres scans `(user_id, created_at, id)` backwards for the `DESC` list, and
   the sweep's `WHERE user_id = $1 AND created_at < $cutoff` uses the same prefix.
2. **None is available.** `scripts/ci/migration-safety.mjs` fails any migration
   containing `CREATE INDEX` without `CONCURRENTLY`, and `src/db/migrate.ts` runs
   every file inside `BEGIN`/`COMMIT`, where Postgres refuses
   `CREATE INDEX CONCURRENTLY`. **Issue #11 is marked closed as completed, but
   neither file has changed** — the guard still carries the rule at line 67 and
   the runner still wraps each file in a transaction. This spec treats the
   conflict as live, because the code says it is. Reopening #11 is a follow-up
   this plan asks for.

The guard's regex would also reject a `CREATE INDEX` against a table created three
lines earlier in the same file, where the lock argument does not apply at all.
That is a false positive, and routing around it by declaring an index as a
`UNIQUE` constraint would be using the loophole F-009 found and explicitly
declined to use. This design does not need the loophole: the primary key here is a
genuine uniqueness statement about the data, not an index wearing a constraint's
clothes.

**Rejected: a nullable `user_id` so that failed sign-ins against unknown addresses
could be recorded.** It fails on three counts at once. Postgres forbids NULL in a
primary key, so the composite key above would become a `UNIQUE` constraint — the
loophole, for a row nobody can read. The retention sweep is caller-scoped by
construction (ADR 0017 rule 1), and an ownerless row has no caller, so the
highest-volume rows in the table would be the only ones nothing ever sweeps.
And the rows would be pure cost: without the attempted address they say only "a
sign-in failed at T", which `audit_events_total` already says more cheaply.

**Rejected: a `session_public_id uuid` column.** ADR 0014 anticipated it ("F-014
can record `public_id` in an audit row that outlives the session"), and it is
still a good idea — it would let the activity screen say "this sign-in created the
session you are looking at". It is cut here for budget, not on principle: it is
one nullable column, three call sites, and its only consumer is a screen that does
not exist until F-024. Adding it later is another additive, nullable column with
no contract step — the cheapest possible change — so deferring costs nothing and
carrying it now costs review attention this feature needs elsewhere. F-024 should
ask for it if its design wants it.

**Rejected: a `details jsonb` column.** See ADR 0025. Briefly: it is the column
that turns an auditable, four-field table into an unauditable PII store, because
nothing in a review can tell what a future call site will put in it.

### Key decisions

Two ADRs, one decision each:

- **[ADR 0024 · An audit event is evidence, not a control](../../docs/adr/0024-an-audit-event-is-evidence-not-a-control.md)**
  — the write is awaited, never fatal, never inside the transaction it describes,
  and nothing in the application ever reads it to make a decision.
- **[ADR 0025 · The audit log records a closed set of events and refuses the rest](../../docs/adr/0025-the-audit-log-records-a-closed-set-of-events.md)**
  — what goes in a row, what is refused by name, and how long it is kept.

#### How a write fails — the decision most worth arguing with

`recordAuditEvent` is **awaited, wrapped in `try`/`catch`, and never fails the
request it describes.** A failed insert increments `audit_write_failures_total`,
logs at `error` level, and the user's operation succeeds anyway.

The alternative — fail-closed logging, where an unwritable audit row rejects the
operation — is the position every compliance regime takes, and it is rejected here
for a specific reason rather than a general preference. Consider the sequence in
`POST /api/auth/login`: the password is verified, `createSession` inserts a row,
`setSessionCookie` sets a signed cookie on the reply. If the audit insert then
fails and we convert that into a `500`, the user receives an error **for an
operation that already happened** — a live session exists in the database and,
depending on where the throw lands, a valid cookie may already be on the reply.
Fail-closed would need the audit write to be part of the same transaction as the
state change to mean anything, and that is worse still: `POST /api/auth/password-reset/confirm`
would then roll back a password change and a full session purge because a
bookkeeping row would not insert. **An audit log that can undo a security
operation is a new way to attack the security operation.**

So the rule is the one ADR 0024 states: nothing in this application reads the
audit log to decide anything, therefore the audit log must never decide anything
either. The honest cost is that **the trail can have holes**, which is exactly why
`audit_write_failures_total` exists, is documented as page-worthy, and is the only
counter in this feature whose correct steady value is zero.

If a reviewer wants fail-closed, this is the line to reject on. The change is not
small: it needs the write inside each operation's transaction, a transaction added
to the two routes that do not have one, and a decision about what a user sees when
their sign-in fails because a table is full.

#### Where the write goes relative to the work

**After the state change, before the response, never inside its transaction.** For
`password-reset/confirm` that means after `db.transaction(...)` returns, not within
the callback. The consequence, stated plainly so nobody discovers it during an
incident: a process that commits the transaction and then dies loses the event.
That window is microseconds wide and the alternative is the paragraph above.

#### Retention: 90 days, swept on the sign-in path

The window is **90 days**, a constant in `src/lib/audit.ts`, not an environment
variable — ADR 0017's rule, for its stated reason: a retention period is a privacy
decision that belongs in a spec, not in a `.env` where environments can differ
silently. Ninety rather than F-010's thirty because the question this table
answers is retrospective ("when did that start?"), and a month is routinely less
than the gap between a compromise and its discovery.

The sweep is attached to **`POST /api/auth/login`, on both outcomes**, and to
nothing else:

```sql
DELETE FROM audit_events
 WHERE user_id = $1
   AND (user_id, created_at) IN (SELECT user_id, created_at
                                   FROM audit_events
                                  WHERE user_id = $1
                                    AND created_at < now() - make_interval(days => 90)
                                  LIMIT 100)
```

Caller-scoped in both the outer statement and the subselect, bounded to one batch,
best-effort in a `try`/`catch`, attached to the operation that creates the garbage
and never to a read — ADR 0017's four rules, copied from `src/routes/todos.ts`
rather than reinvented. (The implementation may instead select `ctid` or the full
key; the requirement is that the subselect is `user_id`-scoped and `LIMIT`ed.)

Both outcomes, not just success, is the detail that matters. The high-volume rows
in this table are failed sign-ins against a targeted account, and they are produced
by the attacker, not by the victim. Sweeping on failure too means the attacker's
own traffic purges up to 100 rows for every 1 it writes — "cleanup scales with the
traffic that produces the mess", ADR 0017's phrasing, applied to the one table
where a third party controls the write rate. ADR 0017's stated cost still applies
unchanged: a user who is never signed in against again keeps their rows past the
window, so retention means **at least** 90 days, not at most.

#### Why a new endpoint rather than a parameter on an existing one

F-013 and F-010 both argued _against_ new endpoints, so the opposite conclusion
here needs a reason. It is that there is no list to hang a parameter on: audit
events are a different resource with a different shape from sessions and from
todos, and `GET /api/auth/sessions?events=true` would be a second response schema
behind one path. The pagination is shared instead — the same keyset shape, the same
`cursor`/`limit` names, the same `{ items, nextCursor }` envelope as
`GET /api/todos` — which is where the duplication would actually have hurt.

The list is keyset paginated rather than capped-with-a-flag as F-009's session list
is, because the two tables grow differently: an account has a handful of sessions
and hundreds of audit events, and "show me the older ones" is the entire point of a
retrospective log. The index question that pushed F-009 toward a cap does not arise
here, because the composite primary key already serves the query.

#### Reading your own audit log is not itself an audit event

Rejected: recording `audit.read`. It turns a read into a write, it makes the table
grow fastest for the users who look at it most, and — in a single-tenant,
user-reads-own-data design — it records that a user looked at their own data, which
nobody needs and which is not a security event. The moment an admin can read
someone else's trail, that access **is** an event; that is F-015's or a future
admin feature's problem, and it is named here so the question is not re-derived.

#### Tamper evidence is not claimed

No hash chain, no signature, no `REVOKE UPDATE, DELETE`, no append-only storage.
What is claimed is narrower and worth stating exactly, because "audit log" invites
an assumption: the application contains **one** `INSERT` site and **one** `DELETE`
statement, the delete cannot touch a row newer than 90 days, and there is no route
that updates or deletes an audit row at any age. So a user — including an attacker
holding a stolen session — cannot erase evidence of their own break-in through the
API. Anyone with direct database credentials can rewrite anything, and this feature
does not pretend otherwise. Hash chaining would defend against exactly the
adversary who already owns the database, at the cost of a verification story,
a key, and a repair procedure for the first legitimate gap.

### Backlog split

At ~490 hand-written lines (budget below) this feature is at the guidance and is
split for surface, exactly as F-004/F-017, F-009/F-020, F-010/F-021 and F-013/F-023
were: **it ships with no way to see any of this from a browser.**

**F-024 · Web UI — account activity screen** is added to `specs/features.yaml`,
`deps: [F-014, F-006]`, `risk_tags: [frontend]`, with a stub spec. It owns the
screen, the empty state, the human-readable rendering of `action`, and the
Playwright journey. It inherits three constraints from here: `action` and
`outcome` are opaque strings that the screen must render defensively, because a
newer server can send a value the screen has never heard of; the list is newest
first with the same cursor semantics as the todo list; and **the absence of an
event is not proof that nothing happened** (ADR 0024), so the copy must not claim
the trail is complete.

**Notes for features that will read this design, not decisions for them:**

- **F-015 (account deletion and export)** — gains one table in both directions.
  Deletion is already complete via `ON DELETE CASCADE`, and the export must
  include `audit_events`. This is the second thing F-009 promised F-015 and the
  first this feature delivers.
- **F-020 (session management screen)** — unaffected; it reads F-009's API, which
  is unchanged.
- **F-019 (dashboards)** — `audit_write_failures_total` is the first metric in
  this application whose correct value is exactly zero, which makes it the natural
  first alert rule when a backend exists.
- **#11** — routed around for the sixth time, and this time with a correction: the
  issue is closed but the conflict is still in the code. Reopening it is a
  follow-up.

## Acceptance criteria

- [ ] `POST /api/auth/register` writes exactly one row with
      `action='auth.register'`, `outcome='success'` and the new user's `user_id`,
      and no other audit row — `integration: registration is recorded`
- [ ] A successful `POST /api/auth/login` writes exactly one row with
      `action='auth.login'`, `outcome='success'` for that user —
      `integration: a successful sign-in is recorded`
- [ ] A failed `POST /api/auth/login` against an **existing** address writes
      exactly one row with `action='auth.login'`, `outcome='failure'` for that
      user, and the response is still `401` with the unchanged body —
      `integration: a failed sign-in against a known account is recorded`
- [ ] A failed `POST /api/auth/login` against an address that matches **no**
      account writes **no** row at all — `audit_events` is empty afterwards, and
      the response is byte-identical to the known-address failure —
      `integration: a failed sign-in against an unknown account is not recorded`
- [ ] `POST /api/auth/password-reset` for a known address writes exactly one
      `password_reset.requested` row; for an unknown address it writes none, and
      both return `202` — `integration: a reset request is recorded only for a known account`
- [ ] `POST /api/auth/password-reset/confirm` with a valid token writes exactly
      one `password_reset.completed` row for that user; a request with an invalid
      or expired token writes none —
      `integration: a completed reset is recorded and a rejected one is not`
- [ ] `DELETE /api/auth/sessions/:id` writes one `session.revoked` row, and
      `DELETE /api/auth/sessions` writes one `session.revoked_others` row, both
      owned by the caller — `integration: session revocations are recorded`
- [ ] `POST /api/auth/logout` writes **no** audit row —
      `integration: logout is not recorded`
- [ ] Creating, updating, deleting and restoring a todo writes **no** audit row —
      `integration: todo operations are not recorded`
- [ ] `GET /api/auth/audit-events` returns the caller's rows newest first, each
      with `id`, `action`, `outcome` and `createdAt` and **no** `userId` key,
      asserted against the raw serialised body —
      `integration: lists the caller's own events newest first`
- [ ] **Bob's audit list never contains Alice's events**: with both accounts
      having registered and signed in, Bob's `GET` returns exactly his own rows,
      and a cursor taken from Alice's list still returns only Bob's —
      `integration: the audit list never crosses accounts`
- [ ] With 3 events and `limit=2`, `GET` returns 2 items and a non-null
      `nextCursor`; following it returns the third with `nextCursor: null`, and no
      event appears twice — `integration: the audit list pages by keyset cursor`
- [ ] `?limit=0`, `?limit=101` and `?cursor=banana` each return
      `400 validation_failed`, and `GET` with no session returns `401` —
      `integration: the audit list validates its query and requires authentication`
- [ ] An account with no events returns `200 { items: [], nextCursor: null }`,
      not a `404` — `integration: an empty trail is an empty page`
- [ ] **A failed audit write does not fail the request**: with `audit_events`
      made unwritable for the duration of one request (rename the table in a
      `try`/`finally`), `POST /api/auth/login` still returns `200` with a working
      session cookie, and `audit_write_failures_total` advances by one —
      `integration: an unwritable audit table does not break sign-in`
- [ ] An audit row older than the retention window is purged by a subsequent
      sign-in for that account **and by a failed one**, while a row inside the
      window and another account's expired row both survive —
      `integration: retention sweeps expired events on both sign-in outcomes`
- [ ] Deleting a user row removes that user's audit events via the cascade —
      `integration: audit events die with the account`
- [ ] No log line produced across register, sign-in, a failed sign-in and an audit
      list contains an email address, a session token or hash, a public session
      id, or a user agent, asserted against a captured log stream via the
      `logStream` build option — `integration: audit paths log no identifiers`
- [ ] `/metrics` exposes `audit_events_total` with `action` and `outcome` labels
      covering at least `auth.login`/`success` and `auth.login`/`failure`,
      `audit_write_failures_total`, and `audit_events_purged_total` —
      `integration: exposes audit counters`
- [ ] `openapi.json` documents `GET /api/auth/audit-events` with its `200`, `400`
      and declared parameters — `npm run openapi:check` fails if the checked-in
      file is stale

## Test plan

| Layer       | Cases                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unit        | **None required**, the position F-003, F-010 and F-013 took for the same reason: there is no pure logic here. `recordAuditEvent` is an `INSERT` in a `try`/`catch`, the retention cutoff is one constant, and the only branching — which call site fires which action — is a property of the routes, provable only through them. A unit test here would assert a mock of `db.insert`.                                                                                                                                                                                                                                                                                                                                                                               |
| integration | A new `tests/integration/audit.test.ts` for the read endpoint and the table's behaviour, plus assertions added to the existing `auth.test.ts`, `password-reset.test.ts` and `sessions.test.ts` at the call sites they already cover. **happy path** (register, sign in, list the two events) · **validation failure** (`limit` bounds, unparseable `cursor`) · **unauthenticated** (no cookie) · **other user's resource** (Bob's list over Alice's events, including with Alice's cursor — the case that matters most) · one case per recorded action · the two negative cases (unknown-address sign-in, logout) · the write-failure injection · the retention sweep on both outcomes · the cascade · a raw-body scan for `userId` · a log-stream scan · counters. |
| e2e         | **None, deliberately.** There is no browser surface until F-024, so an e2e here would be `request.get()` calls duplicating the integration suite at the cost of a container boot — the argument F-004, F-008, F-009, F-010 and F-013 each made, and sharper here because `deploy.yml` runs Playwright against `STAGING_URL` and this suite would be writing real audit rows into a deployed environment on every deploy. The assertion this feature actually needs from e2e is that **the existing journeys still pass unchanged**: registration and sign-in now do one more write each, and F-006's and F-016's journeys are what prove that is invisible.                                                                                                         |
| load        | **No new k6 scenario and no new threshold.** `load/smoke.js` already registers a fresh account per iteration tagged `endpoint:register`, so the added `INSERT` is measured by the existing run; the sweep runs only on `login`, which the smoke scenario does not call, so its cost is unmeasured by design rather than by omission. Rejected: adding `http_req_duration{endpoint:register}` to the thresholds. It is tempting because this feature adds work to an auth path, but there is no recorded baseline for that tag, and a threshold picked from a guess is a flaky gate — which `AGENTS.md` rule 1 then makes expensive to remove. `http_req_failed: ['rate<0.01']` already covers a write that starts failing.                                          |

## Security considerations

**This feature exists to make an attack visible, and the attacker is inside the
threat model.** An attacker holding a stolen session cookie can read the victim's
audit trail. That is accepted for the reason F-009 accepted the equivalent: they
already have everything the account owns, and what they gain here — knowing when
the real user last signed in — is information the account's own UI gives them
anyway. What they **cannot** do is remove their traces: there is no update path and
no delete path on this table reachable from any route, and the one `DELETE` in the
application cannot touch a row less than 90 days old. Evidence of a break-in
survives the break-in. That property is worth checking directly in review, because
it is the one this feature's value rests on.

**Cross-account isolation.** `GET /api/auth/audit-events` scopes by
`eq(auditEvents.userId, request.user!.id)` in the `WHERE`, and the response schema
declares no `userId`, so the owner column cannot reach a body even by accident —
the same mechanical guard F-009 used to keep the session hash out. There is no
by-id route and therefore no `404`-versus-`403` question. This has its own named
acceptance criterion, including the case where the caller passes a cursor value
observed from another account's list, which is well-defined ("my rows older than
this instant") and carries no permission.

**A cursor is a timestamp, not a capability.** Inherited unchanged from ADR 0002
and F-013: the cursor is `AND`ed with `user_id = $caller`, so a forged or borrowed
cursor selects a different slice of the caller's own rows and nothing else.

**User enumeration — the one asymmetry in this design, stated rather than
buried.** `POST /api/auth/login` and `POST /api/auth/password-reset` both go to
great lengths to behave identically for known and unknown addresses: login always
runs `verifyPassword` against `DUMMY_HASH`, and the reset route generates a token
on both branches specifically so the response time does not reveal account
existence. **This feature adds an `INSERT` to the known branch of both.** The
response bodies and status codes remain byte-identical — there is an acceptance
criterion for exactly that — so the only channel is timing, and the bounds are:
one small `INSERT` into a table with a single index, against an argon2id
verification (`m=19456, t=2`) that runs on both branches and costs two orders of
magnitude more; plus `AUTH_RATE_LIMIT_MAX` (10/minute) on login and
`PASSWORD_RESET_RATE_LIMIT_MAX` (5/hour) on the reset route, which bounds how many
samples an attacker can average over. The judgement is that the signal is below
the noise floor of a network round trip and far below argon2's own variance. **If
a reviewer disagrees, the fix is to insert on both branches with a synthetic
owner, and that is the nullable-`user_id` design rejected in "Data model
changes"** — so disagreeing here means reopening that decision too, not adding a
line.

**The audit table is a write amplifier a third party controls.** Failed sign-ins
against a known address are written by whoever is attacking that address, not by
its owner. One row per attempt, capped by `AUTH_RATE_LIMIT_MAX` per IP — but the
limiter keys on `request.user?.id ?? request.ip` and an unauthenticated login has
no user, so a distributed attack is bounded per-source and not per-target. At
roughly 100 bytes a row this is a storage nuisance rather than an outage, and the
sweep's asymmetry is the main mitigation: every attempt purges up to 100 expired
rows and writes 1. The residual — sustained attack traffic accumulating inside the
90-day window — is real, and the named remedy if it ever bites is a per-account
cooldown on `failure` rows, using exactly the mechanism `password_reset_tokens`
already uses for its 60-second window (`ON CONFLICT ... WHERE created_at <
now() - interval`). It is not built now because nobody has been attacked yet and
an unneeded coalescing rule makes the log lie about attempt counts.

**No new PII category, and one deliberate refusal.** The four columns are a row
id, an account id, a short action string and a timestamp. No email address, no IP,
no user agent, no request body, no `details jsonb`. ADR 0015 rejected putting a
location on a session and named this feature as the likelier home for one; the
answer is still no, and the reason is the same — an IP column here would be a
90-day rolling location history for every account, one subpoena away from
mattering, and worth precisely as much as `TRUST_PROXY` is correct. What the table
does newly reveal, and F-015 must therefore export, is **behavioural** data: when
an account signs in, and how often.

**Nothing new is logged.** Events go to the table, not to the log stream. The
existing outcome-only log lines in `auth.ts` and `sessions.ts` are unchanged, and
the new endpoint logs nothing beyond the access log, whose URL for this route
carries no path parameter and no user content. The log-stream assertion is the
same one F-009, F-010 and F-013 each shipped.

**CSRF and rate limiting.** The one new route is a `GET` behind `requireAuth`,
which changes no state, so there is no CSRF surface. It is covered by the global
per-account limiter at `RATE_LIMIT_MAX`, distributed since F-011; no new bucket
and no new configuration key. The six existing routes keep the limits they have —
notably, this feature does **not** loosen `AUTH_RATE_LIMIT_MAX`, which is what
keeps the write amplifier above bounded per source.

## Observability

- **`audit_events_total{action, outcome}`** — a new Prometheus counter in
  `src/plugins/metrics.ts`, passed into the routes the way `sessionsRevoked`
  already is, incremented once per row successfully written. Bounded cardinality
  by construction: the action set is closed (7 values today) and `outcome` has
  two, so at most 14 series. No user id and no email as a label — one is unbounded
  cardinality, the other is PII. **The reading that matters is
  `action="auth.login", outcome="failure"` rising across the population**, which is
  credential stuffing seen from the front door rather than inferred from the login
  error rate, and it complements F-009's `sessions_revoked_total{scope="others"}`
  — the same attack shows up first as failures here and later as users revoking
  sessions there.
- **`audit_write_failures_total`** — no labels. **The only counter in this
  application whose correct value is exactly zero**, and the direct consequence of
  ADR 0024: because a failed write is invisible to the user by design, this is the
  only thing that says the trail has holes. Any non-zero value means the log is
  incomplete and every conclusion drawn from it afterwards is unsound. It is
  paired with an `error`-level log line carrying `err` and the action, and it is
  the first alert rule F-019 should carry.
- **`audit_events_purged_total`** — advanced by the number of rows the sweep
  actually removed, so it carries how wide each sweep was. ADR 0017's stated
  operational tell, applied here: **flat at zero for longer than 90 days after
  launch means retention is fiction**, and nothing else in the system will say so.
- **`http_request_duration_seconds{route="/api/auth/audit-events"}`** — from the
  existing `onResponse` hook, one label, no change needed. The p95 is the early
  warning for an account whose trail has grown past what the keyset scan handles
  cheaply, which under the write-amplification scenario above is the account under
  attack.
- **Not measured:** the row count of `audit_events`, which would be a gauge over a
  `COUNT(*)` on every scrape. `audit_events_total` minus `audit_events_purged_total`
  is the answer, computed where the cost is not on the scrape path.

## Rollout

**No feature flag and no configuration.** One new route registered
unconditionally, seven call sites that always write, and a retention window that
is a constant in the code (ADR 0017). The deployed contract matches `openapi.json`
in every environment, which is the position F-004, F-009, F-010 and F-013 all
took. There is no new environment variable to set before merging, and no
`docs/deployment-sevalla.md` change.

**Order.** Merge. One PR, one additive migration, applied at container start by
`scripts/docker-entrypoint.sh` before the server boots. `CREATE TABLE` on an empty
new relation takes no lock anything else wants.

**During the rolling deploy, both versions are correct, and the trail has a
documented gap.** Old instances serve register, sign-in and revoke exactly as they
do today and write no audit rows; new instances write them. So events that happen
mid-rollout are recorded only if they land on a new instance. Nothing is
inconsistent and no request fails — the gap is simply the honest consequence of
the feature not having existed five minutes ago, and it is the same shape as the
holes ADR 0024 already accepts. `GET /api/auth/audit-events` is a `404` on old
instances for the length of the rollout.

**Rollback at 2am.** Redeploy the previous image. The table is unread by the old
code, the route vanishes with the image, and no existing table, column, response,
cookie or limit was modified. **The migration can and should stay applied**:
leaving it costs an empty table, and rolling it back would need a `DROP TABLE`,
which is a destructive migration that must ship alone anyway. Nothing written by
the new version needs undoing, and no session, token or todo is affected by the
rollback.

**What to watch after deploying, in order:**

1. `audit_write_failures_total` — must be zero. Non-zero on day one usually means
   the migration did not apply, which is also visible as a failed container start.
2. `audit_events_total{action="auth.register"}` against the registration rate from
   `http_request_duration_seconds{route="/api/auth/register"}` — they should track
   each other one-for-one. A divergence means a call site was missed.
3. `http_request_duration_seconds{route="/api/auth/login",status="200"}` p95
   against its pre-deploy value. Sign-in now does one extra `INSERT` and one
   bounded `DELETE`; if that is visible at p95, the sweep batch is the suspect
   before the insert is.
4. `audit_events_purged_total` from day 91 onward. Still zero means retention is
   not happening.

**Follow-ups this creates:**

- **F-024** — the account activity screen (added by this plan). Until it ships,
  the trail is reachable only by a client that speaks HTTP directly, the position
  F-004, F-009, F-010 and F-013 each shipped in.
- **F-015** — gains `audit_events` in its export. Deletion needs no work: the
  cascade already covers it, which is one of the reasons `user_id` is `NOT NULL`.
- **#11 should be reopened.** It is closed as completed, but
  `scripts/ci/migration-safety.mjs` still carries the `CREATE INDEX` rule and
  `src/db/migrate.ts` still wraps each file in a transaction. This feature does not
  need an index, so nothing here is blocked — but the next feature that does will
  be, and it will believe the issue is fixed.
- **No contract migration is owed.** Unlike F-009, this feature leaves no
  `SET NOT NULL` behind.

**Diff budget.** Estimated ~490 hand-written lines: `drizzle/0007_audit_events.sql`
(~30, mostly comment), `src/db/schema.ts` (~22), `src/lib/audit.ts` (~55),
`src/routes/auth.ts` (~28 across five call sites), `src/routes/sessions.ts` (~10),
`src/routes/audit.ts` (~65), `src/plugins/metrics.ts` (~16), `src/app.ts` (~4),
`tests/integration/helpers.ts` (~1), integration tests (~260), plus a regenerated
`openapi.json` (generated, excluded). At the ~500 guidance, which is why F-024
exists rather than a screen in this PR, and why `session_public_id` was cut. If it
runs over, cut the cascade case and the logout/todo negative cases — **never** the
cross-account case, the unknown-address case, or the write-failure injection, which
are this feature's security and correctness properties.
