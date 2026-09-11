# F-010 · Soft delete and restore for todos

> Status is tracked in `specs/features.yaml`, not here.

## Problem

Deleting a todo is irreversible and takes one click. `DELETE /api/todos/:id`
removes the row, and F-016's list screen calls it from a button sitting next to
the completion checkbox — the two controls a user hits most often, one recoverable
and one not. A misclick, a phone in a pocket, or a retried request against the
wrong id destroys something the user wrote, with no way to get it back and no way
for support to help: the row is gone from the database, not merely hidden. Every
other state in the application is reversible; deletion is the one operation where
a wrong click is final.

## Scope

**In scope**

- `DELETE /api/todos/:id` marks a todo deleted instead of removing the row, with
  the same `204` contract it has today
- A deleted todo is invisible to every existing read: the list, `GET /:id`, and
  `PATCH /:id` all behave exactly as if the row were gone
- Listing deleted todos, as a filter on the existing list endpoint
- Restoring a deleted todo in place, by id, keeping the same id, `created_at`,
  title, and completion state
- One additive migration adding a nullable `deleted_at` to `todos`
- A retention window after which a deleted row is removed for real, enforced
  without a scheduler

**Out of scope**

- **Browser screens.** F-016's list screen keeps working unchanged (its delete
  button still gets a `204`, the row still disappears), but it gains no undo and
  no trash view here. **F-021**, added to the backlog by this plan, owns that
  screen and the browser journey. See "Backlog split".
- **A "delete permanently now" endpoint.** Nobody asked for one, and it would
  re-introduce the irreversible operation this feature exists to remove. Account
  -wide erasure is F-015; the retention sweep covers everything else.
- **Undeleting anything other than a todo.** Sessions, users, and tokens are
  unaffected; `deleted_at` is added to one table.
- **A configurable retention window.** 30 days is a constant in the code, not an
  environment variable. See "Key decisions".
- **Cascading soft delete or a soft-deleted user.** F-015 owns account deletion,
  and the existing `ON DELETE CASCADE` still removes todos — including
  soft-deleted ones — with the account.
- **Fixing issue #29** (the `created_at`-only cursor can skip a row under
  concurrent creation). Pre-existing in F-003, orthogonal to this change, and
  explicitly not repaired here. The interaction is documented below so whoever
  fixes it keeps the new predicate.
- **Auditing who deleted what.** That is F-014; a todo has exactly one owner, so
  there is nothing to attribute here that `user_id` does not already say.

## Design

### API changes

One new endpoint, one new query parameter, one changed behaviour behind an
unchanged contract. All in the existing `src/routes/todos.ts`, under the existing
`todos` tag.

| Method | Path                     | Auth    | Notes                                                                                                        |
| ------ | ------------------------ | ------- | ------------------------------------------------------------------------------------------------------------ |
| GET    | `/api/todos`             | session | Gains `&deleted=true\|false` (default `false`). `false` excludes deleted rows; `true` returns **only** them. |
| DELETE | `/api/todos/:id`         | session | **Behaviour change:** sets `deleted_at` instead of removing the row. Still `204`. Still `404` if not live.   |
| POST   | `/api/todos/:id/restore` | session | Clears `deleted_at`. `200` with the restored `TodoView`. `404` if the todo is not the caller's.              |
| GET    | `/api/todos/:id`         | session | Unchanged contract; a deleted todo now answers `404`.                                                        |
| PATCH  | `/api/todos/:id`         | session | Unchanged contract; a deleted todo now answers `404`. Editing requires restoring first.                      |

`TodoView` gains one field, and it is the only response-shape change:

```ts
{
  id: string;
  title: string;
  completed: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null; // new — null for every live todo
}
```

Additive and `null` on every existing row, so `web/src/todos.ts`'s `Todo`
interface needs no change: it does not name the field and `apiFetch` does not
reject extra keys. F-016 is untouched by this PR.

| Situation                                              | Response                            | Side effect                                  |
| ------------------------------------------------------ | ----------------------------------- | -------------------------------------------- |
| `DELETE /:id` on a live todo of the caller's           | `204`, empty body                   | `deleted_at = now()`, plus a retention sweep |
| `DELETE /:id` on a todo the caller already deleted     | `404 { code: "not_found" }`         | None                                         |
| `DELETE /:id` on another user's todo                   | `404 { code: "not_found" }`         | **None** — their row is not even read        |
| `POST /:id/restore` on a deleted todo of the caller's  | `200` with the `TodoView`           | `deleted_at = NULL`, `updated_at = now()`    |
| `POST /:id/restore` on a **live** todo of the caller's | `200` with the `TodoView`           | None that matters — see below                |
| `POST /:id/restore` on another user's or an unknown id | `404 { code: "not_found" }`         | None                                         |
| `POST /:id/restore` with a non-uuid id                 | `400 { code: "validation_failed" }` | None                                         |
| `GET /api/todos?deleted=true`                          | `200 { items, nextCursor }`         | None                                         |
| Any of these without a session                         | `401 { code: "unauthorized" }`      | None                                         |

**Restore is idempotent, and restoring a live todo is a `200`, not a `409`.** The
statement carries no `deleted_at IS NOT NULL` predicate, so a double-click, a
retry after a dropped connection, or a restore of something a second tab already
restored all return the same row and the same status. Rejected: `409 conflict`
for "that todo is not deleted", which is a branch every client then has to
implement in order to treat it as success anyway. The visible cost is that
restoring a live todo bumps `updated_at`; that is acceptable and is asserted in
the tests rather than hidden.

**`POST /:id/restore`, not `PATCH /:id { deleted: false }`.** Rejected: a
`deleted` field on the existing `PATCH` body. `PATCH` must refuse to touch
deleted rows — otherwise "edit the title of something I deleted" becomes a
reachable state and the `404` rule above stops being a rule — which means the
same request would need `deleted_at IS NULL` in its `WHERE` for two of its fields
and not for the third. A sub-resource verb keeps one statement per endpoint and
keeps `PATCH`'s predicate uniform. Rejected also: `DELETE
/api/todos/:id/deletion`, which is tidier REST and unreadable in a client.

**No `Idempotency-Key` support on restore.** The idempotency plugin is wired onto
`POST /api/todos` only (ADR 0005). Restore is already idempotent by construction,
so a key would buy replay semantics for an operation that is replay-safe, at the
cost of a row in `idempotency_keys` per restore.

**`404`, never `403`.** Unchanged from F-003 and AGENTS.md: every statement
carries `user_id = $caller` in the `WHERE`, nothing is fetched then checked, and
a row belonging to someone else does not exist as far as the response is
concerned. This now covers two more surfaces — restore and the `deleted=true`
listing — and both are named in the acceptance criteria.

### Data model changes

One migration, `drizzle/0006_todos_soft_delete.sql`, on the existing `todos`
table. **Purely additive**, so it is legal alongside `src/` changes under
`scripts/ci/migration-safety.mjs` rule 2.

```sql
-- Nullable, no default: catalogue-only in Postgres 17. No table rewrite, no
-- long lock, and no backfill — NULL already means exactly "not deleted" for
-- every row that exists.
ALTER TABLE todos ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
```

Mirrored in `src/db/schema.ts` as
`deletedAt: timestamp('deleted_at', { withTimezone: true })` — nullable in the
model too, because `NULL` is a value this design relies on rather than a gap
waiting to be filled.

**Expand / contract, stated explicitly** (ADR 0003): **there is no contract
step.** This is the whole migration. `deleted_at` is nullable permanently — `NULL`
is the meaningful "live" value, not a temporary state before a backfill — so
unlike F-009 there is no deferred `SET NOT NULL`, no follow-up migration-only PR,
and no checklist item hanging off this feature's issue. The expand step is the
only step.

**No new index, deliberately.** The list query's access path is unchanged:
`WHERE user_id = $1 [AND created_at < $cursor] ORDER BY created_at DESC` is still
served by `todos_user_id_created_at_idx` from `0001_init.sql`, and `deleted_at IS
NULL` (or `IS NOT NULL`) is a filter applied to rows that index already narrowed
to one account, not a new access path. AGENTS.md's rule is about a `WHERE` or
`ORDER BY` on an unindexed column that drives the scan; nothing here drives a
scan. The alternative — a partial index `... WHERE deleted_at IS NULL` — would be
the textbook answer and is blocked anyway: `scripts/ci/migration-safety.mjs`
requires `CREATE INDEX CONCURRENTLY`, which `src/db/migrate.ts` cannot run inside
its transaction (issue #11). Routed around, as F-004, F-005 and F-009 each did.

This is also why the trash listing sorts by `created_at` and not `deleted_at`;
see the next section.

**Why a column and not an archive table.** Recorded as
[`docs/adr/0016-soft-delete-is-a-nullable-timestamp.md`](../../docs/adr/0016-soft-delete-is-a-nullable-timestamp.md).
Rejected: moving the row to a `deleted_todos` table on delete and back on
restore. It duplicates the schema (and every future column, starting with
F-013's), turns one `UPDATE` into a two-statement transaction in both directions,
loses the row's identity to any future foreign key, and makes "is this id taken?"
a question about two tables. The cost of the column is the one this spec spends
the rest of its length on: every reader of `todos` must now say which rows it
means.

### Key decisions

Two ADRs, one decision each:

- **[`docs/adr/0016-soft-delete-is-a-nullable-timestamp.md`](../../docs/adr/0016-soft-delete-is-a-nullable-timestamp.md)**
  — deletion is a column on the row, and the default meaning of `todos` is "live".
- **[`docs/adr/0017-retention-without-a-scheduler.md`](../../docs/adr/0017-retention-without-a-scheduler.md)**
  — retention windows are enforced by bounded opportunistic sweeps on the request
  path that creates the rows, not by a background job.

Summarised, with what was rejected:

**Deleted todos are excluded by default, and the default is the one nobody has to
remember.** Every read in `src/routes/todos.ts` grows `deleted_at IS NULL` in its
`WHERE` — list, `GET /:id`, `PATCH /:id` — and `deleted=true` is the single
explicit opt-out. Rejected: a Drizzle-level or view-level default (`CREATE VIEW
live_todos`), which hides the predicate from the query the reviewer reads and
means the next feature that writes SQL against `todos` silently gets whichever
one it happened to name. The predicate is visible at every call site on purpose,
which is also the handoff to F-013 below.

**The retention window is 30 days, hard-coded, and enforced opportunistically.**
No scheduler exists anywhere in this repository — the only existing retention
mechanism is `src/plugins/idempotency.ts`'s sweep, a bounded `DELETE` over the
caller's own rows on the request path, best-effort and logged on failure. This
feature copies that shape exactly: after a successful soft delete, the handler
deletes up to 100 of that user's rows whose `deleted_at` is older than 30 days,
inside a `try/catch` that never fails the request. Rejected: a cron container or
an in-process timer, which is a process to deploy, monitor, lock against
concurrent replicas, and own — for a table whose garbage is generated one row at
a time by the very request that can clean it up. Rejected: never purging, which
keeps content a user believes is deleted forever and makes the retention promise
unwriteable. Rejected: an env var, which would put a privacy-relevant number in
`.env.example`, the config schema, the fail-closed production validation (ADR 0007) and the deployment docs, so that nobody can tune it. The honest consequence
is in ADR 0017: **retention is "at least 30 days", not "at most"** — a user who
deletes one todo and never returns keeps that row indefinitely.

**The sweep runs on `DELETE`, not on the list.** Rejected: sweeping on
`GET /api/todos`, which is the hot read path, runs for every user including those
who have never deleted anything, and would put a write into a request that has
none. Delete traffic is exactly the traffic that creates the rows to be purged,
so the cleanup is self-scaling per account: each delete purges up to 100 expired
rows, so a user's backlog shrinks faster than they can grow it.

**`deleted=true` returns only deleted todos, ordered by `created_at DESC` like
everything else.** Rejected: a separate `GET /api/todos/deleted` endpoint, which
duplicates the pagination, the limit validation, the response schema and the
cursor semantics for a query that differs by one predicate. Rejected: a
three-state `deleted=any` that mixes live and deleted rows, which nobody asked
for and which makes every client re-derive "is this one gone?" per row. Rejected:
ordering the trash by `deleted_at DESC`, which reads better ("most recently
deleted first") but makes the cursor mean a different column in one mode than in
the other — a cursor copied between modes would then silently return nonsense —
and needs a `(user_id, deleted_at)` index, which is issue #11 again. One sort
key, one cursor shape, one index, in both modes.

**`DELETE` keeps its `204` and still `404`s on a second call.** Rejected:
returning the soft-deleted `TodoView` with a `200`, which would be more useful to
a client building undo but changes a shipped contract and `openapi.json` for
every existing caller. The client that wants to offer undo already has the id it
just deleted, and `POST /:id/restore` returns the full row. The second `DELETE`
returning `404` falls out of the `deleted_at IS NULL` predicate and is the
behaviour `web/src/todos.ts` already handles — it swallows a `404` on delete as
"already gone", which stays true.

### Interaction with F-003's keyset pagination

This is the question the feature most obviously raises, so it is answered in
full rather than assumed.

**Excluding rows does not weaken the cursor.** The cursor is a _value_ —
`created_at` of the last row returned — not an offset and not a row reference.
The next page is defined as "the first `limit` rows matching the filter with
`created_at < cursor`". Removing a row from the middle of the ordering, whether
by the hard `DELETE` that exists today, by the `completed` filter changing, or by
the new `deleted_at IS NULL`, does not move any other row relative to that value.
This is precisely the property ADR 0002 bought by refusing `OFFSET`, where a row
disappearing between two requests does shift the window and does skip a row.

Two consequences worth stating because they are easy to get wrong in review:

1. **The filter must be in SQL, never applied to the rows after they come back.**
   The handler fetches `limit + 1` rows _already filtered_, so pages stay full and
   `nextCursor` stays correct. A post-fetch `.filter()` would return short pages
   with a non-null `nextCursor` and would make `limit` mean "up to limit", which
   is a different API. It is also the same rule as the authorization one: filter
   in the `WHERE`, never in application code.
2. **The cursor row itself may be deleted between two page requests, and that is
   fine.** `created_at < $cursor` never looks the cursor row up, so a cursor
   whose row no longer matches the filter still describes exactly the same
   position. `web/src/todos.ts` already treats `nextCursor` as opaque and echoes
   the server's string rather than recomputing it from a rendered row, for this
   reason.

**Restore is the genuinely new case, and it is benign.** Clearing `deleted_at`
re-inserts a row into the middle of the ordering at its original `created_at` —
possibly behind a cursor the client has already scrolled past, in which case the
restored todo does not appear until the list is reloaded. This is accepted, not
worked around: the restore response carries the full row (ADR 0008), so the
client that performed the restore can place it itself without a refetch, and the
only way to reach the state at all is for the user to have just restored it. The
alternative — re-stamping `created_at` to `now()` on restore so the row returns
at the top — was rejected: it lies about when the todo was written, reorders the
list under the user, and breaks any cursor a second tab is holding.

**Issue #29 is untouched and must stay fixed correctly.** The `(created_at, id)`
composite cursor proposed there is orthogonal to this change; whoever implements
it keeps `deleted_at IS NULL` in the same `WHERE` and the two compose without
interacting. It is called out here only so the fix is not written against a
pre-F-010 copy of the query.

### Algorithm

**List**, after `requireAuth`, with `deleted` defaulting to `false`:

```sql
SELECT * FROM todos
 WHERE user_id = $1
   AND deleted_at IS NULL          -- or IS NOT NULL when deleted=true
   [AND created_at < $cursor]
   [AND completed = $x]
 ORDER BY created_at DESC
 LIMIT $limit + 1;
```

`ListQuery` gains `deleted: z.enum(['true','false']).default('false').transform(...)`,
matching the existing `completed` parameter's shape exactly. `nextCursor` is
computed as it is today.

**Soft delete.** One statement, replacing the current `DELETE`:

```sql
UPDATE todos SET deleted_at = now(), updated_at = now()
 WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
 RETURNING id;
```

No row → `notFound('Todo not found')`. Otherwise `204`, unchanged. Then the
sweep, best-effort, mirroring `src/plugins/idempotency.ts` line for line:

```sql
DELETE FROM todos
 WHERE user_id = $1
   AND id IN (SELECT id FROM todos
               WHERE user_id = $1
                 AND deleted_at < now() - interval '30 days'
               LIMIT 100);
```

Wrapped in `try/catch`; on failure `request.log.warn({ err, todo: { outcome:
'sweep_failed' } })` and the request still returns `204`. Bookkeeping never fails
a user's request.

**Restore.** One statement, no `deleted_at` predicate (see "idempotent" above):

```sql
UPDATE todos SET deleted_at = NULL, updated_at = now()
 WHERE id = $1 AND user_id = $2
 RETURNING *;
```

No row → `notFound('Todo not found')`. Otherwise `200` with the row.

**Reads.** `GET /:id` and `PATCH /:id` each gain `AND deleted_at IS NULL` to
their existing `WHERE`. Both already `404` on no row, so no handler logic
changes.

### Backlog split

The API fits in one PR (~330 hand-written lines; budget below). The browser does
not, and this feature ships with **no user-facing way to restore anything**:
F-016's delete button keeps working and keeps looking permanent, while the row is
now recoverable for 30 days by anyone who can speak HTTP. That is the same
position F-004 and F-009 shipped in, and it is called out at the top of the issue
rather than left to be discovered.

**F-021 · Web UI — undo delete and trash view** is added to `specs/features.yaml`,
`deps: [F-010, F-016]`, `risk_tags: [frontend]`, with a stub spec. It owns the
undo affordance after a delete, the trash view over `?deleted=true`, and the
Playwright journey. It inherits two constraints from here: a restored todo comes
back at its original position in the ordering (so the screen places it from the
restore response rather than refetching, per ADR 0008), and the 30-day window
must be stated in the UI copy, because "deleted" now means something different
from what the button says.

**Notes for features that will read this table, not decisions for them:**

- **F-013 (full-text search)** — after this ships, `todos` contains rows the user
  believes are gone, so a search that returns them is a bug rather than a feature.
  Whatever index F-013 builds must either be partial (`WHERE deleted_at IS NULL`)
  or carry the predicate in the query, and F-013 has to decide explicitly whether
  the trash is searchable at all. Flagged, not decided here.
- **F-012 (read-through cache)** — the list cache key gains a dimension: it is now
  `(user, limit, cursor, completed, deleted)`, and a key that omits `deleted`
  serves the trash to the live view or worse. Two invalidation points also change
  shape: `DELETE` is no longer "the row is gone" but an `UPDATE`, and restore is a
  new write path that must invalidate both the live and the trash views for that
  user. Flagged, not decided here.
- **F-015 (account deletion and export)** — deletion is already covered: the
  existing `ON DELETE CASCADE` removes soft-deleted rows with the account like any
  other. The export must decide whether a user's trash is part of their data. It
  is still their content, and it is still in the database; F-015 should say so
  either way rather than let the `WHERE` clause decide.

## Acceptance criteria

- [ ] `DELETE /api/todos/:id` on a live todo returns `204`, the row still exists
      in the database with a non-null `deleted_at`, and `GET /api/todos/:id`
      then returns `404` — `integration: delete hides the todo without removing the row`
- [ ] A soft-deleted todo does not appear in `GET /api/todos`, and the todos
      around it do — `integration: deleted todos are excluded from the default list`
- [ ] `PATCH /api/todos/:id` on a soft-deleted todo returns `404` and leaves the
      row's title and `completed` unchanged in the database —
      `integration: a deleted todo cannot be edited`
- [ ] A second `DELETE /api/todos/:id` on an already-deleted todo returns `404`
      and does not move `deleted_at` — `integration: deleting twice is a 404`
- [ ] `POST /api/todos/:id/restore` returns `200` with the same `id`, `title`,
      `completed` and `createdAt` as before deletion and `deletedAt: null`; the
      todo then appears in `GET /api/todos` and answers `200` on `GET /:id` —
      `integration: restore brings the todo back in place`
- [ ] `POST /api/todos/:id/restore` called twice returns `200` both times, and
      calling it on a todo that was never deleted returns `200` with
      `deletedAt: null` — `integration: restore is idempotent`
- [ ] `GET /api/todos?deleted=true` returns only deleted todos and no live ones;
      `?deleted=false` and the parameter's absence behave identically —
      `integration: the trash listing returns only deleted todos`
- [ ] With 3 deleted todos and `limit=2`, `?deleted=true` returns 2 items and a
      non-null `nextCursor`, and following that cursor returns the third with
      `nextCursor: null` — `integration: the trash listing paginates by keyset`
- [ ] Soft-deleting a todo that sits **between** two pages does not cause any
      other todo to be skipped: with 5 todos at `limit=2`, deleting the row that
      would have started page 2 after page 1 was fetched still yields the
      remaining 4 across the following pages, with no duplicates —
      `integration: deleting a row mid-scroll does not skip its neighbours`
- [ ] Every live response carries `deletedAt: null` — create, get, patch and list
      — `integration: TodoView always carries deletedAt`
- [ ] Bob cannot soft-delete Alice's todo: `DELETE` returns `404` and Alice's row
      still has `deleted_at IS NULL`; Bob cannot restore Alice's deleted todo:
      `POST /:id/restore` returns `404` and her row's `deleted_at` is unchanged;
      Alice's deleted todo never appears in Bob's `?deleted=true` listing —
      `integration: another user's todo can be neither deleted nor restored`
- [ ] `POST /api/todos/:id/restore` returns `401` with no session, and `400
validation_failed` for a non-uuid id —
      `integration: restore requires authentication and a valid id`
- [ ] A row whose `deleted_at` is set to 31 days ago (written directly via the
      test's `db` handle) is gone from the database after the caller soft-deletes
      any other todo, while a row deleted 29 days ago and every live row survive
      — `integration: the retention sweep purges rows past the window and nothing else`
- [ ] The sweep never touches another account: with expired deleted rows seeded
      for both Alice and Bob, Alice deleting a todo removes hers and leaves Bob's
      — `integration: the retention sweep is scoped to the caller`
- [ ] `/metrics` exposes `todos_soft_delete_total` with `action` covering
      `deleted`, `restored` and `purged`, and `purged` advances by the number of
      rows actually removed — `integration: exposes soft delete counters`
- [ ] No log line produced across a delete-restore-delete cycle contains a todo
      title, asserted against a captured log stream via the `logStream` build
      option — `integration: todo titles are never logged`
- [ ] `openapi.json` documents `POST /api/todos/:id/restore`, the `deleted` query
      parameter, and `deletedAt` on `TodoView` — `npm run openapi:check` fails if
      the checked-in file is stale

## Test plan

| Layer       | Cases                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unit        | **None required**, the position F-003 took for the same reason: there is no pure logic here beyond zod validation of one new enum parameter. Everything this feature does is a `WHERE` clause, and a unit test cannot prove a `WHERE` clause.                                                                                                                                                                                                                                                                                                                                                       |
| integration | Extends `tests/integration/todos.test.ts`. **happy path** (delete → invisible → restore → visible) · **validation failure** (non-uuid restore id, `deleted=maybe`) · **unauthenticated** (restore with no cookie) · **other user's resource** (Bob cannot delete, restore, or list Alice's — the case that matters most) · double delete · idempotent restore · trash listing and its pagination · mid-scroll deletion across a page boundary · `deletedAt` present on every response · the retention sweep, its window boundary, and its account scoping · counters · a log-stream scan for titles |
| e2e         | **None, deliberately.** There is no browser surface until F-021, so an e2e here would be `request.post()` calls duplicating the integration suite at the cost of a container boot — the argument F-004, F-008 and F-009 each made. F-016's existing "create → complete → delete" journey must still pass unchanged, which is the real e2e assertion this feature needs: the delete button's behaviour is identical from the browser's side.                                                                                                                                                         |
| load        | No new k6 scenario, and no threshold change. `load/smoke.js` does not exercise `DELETE` today, so the sweep is not on a measured path; adding it would measure a `DELETE` against a user with no expired rows, which is the uninteresting case. The list query's plan is unchanged (same index, one extra filter on rows already narrowed to one account), so the existing `p(95) < 200ms` list threshold covers the regression that would matter.                                                                                                                                                  |

## Security considerations

**Cross-account isolation, on two new surfaces.** Restore and the trash listing
are both new ways to ask about a todo by id or by account, and both carry
`user_id = $caller` in the `WHERE` with nothing fetched-then-checked. A restore
of someone else's id returns `404` with no row touched, so the endpoint is not an
existence oracle: an unknown id and another user's id are indistinguishable. This
is the acceptance criterion to re-read before approving, and the one named as
uncuttable in the budget below.

**Deleted content stays readable by its owner for 30 days, by design.** That is
the feature. What it means less obviously: "delete" in F-016's UI now hides
rather than erases, and a user who deletes something _because_ it was sensitive —
the wrong note, a password pasted into a title — has not erased it. They cannot
erase it on demand either, because this feature deliberately ships no permanent
-delete endpoint. The mitigations are that the content remains reachable only by
the account that wrote it (the trash is behind the same session and the same
`user_id` predicate as everything else), that the window is finite and enforced,
and that account-level erasure via F-015 plus the existing cascade removes it
immediately. If the product needs "delete permanently now", that is a separate
feature with its own approval — and this is the sentence in the spec to disagree
with if you are going to disagree with one.

**The retention promise is "at least", not "at most".** A user who deletes one
todo and never comes back keeps that row indefinitely, because nothing sweeps
without a request (ADR 0017). This is a real limitation of the no-scheduler
choice, and it is stated here rather than in a comment because it is the
difference between a retention policy and a retention aspiration. It becomes a
compliance problem only if the application ever promises "deleted within 30 days"
externally; F-015's data-deletion story is unaffected, since it removes the rows
directly.

**The sweep is a `DELETE` on a user-scoped path.** It is bounded to 100 rows, it
is scoped by `user_id = $caller` in both the outer statement and the subselect
(so a bug in one of them cannot widen it to another account), it is wrapped in a
`try/catch` that can only cost the user a log line, and it runs after the soft
delete has already succeeded. The worst outcome an attacker with a valid session
can force is deleting their own already-deleted rows slightly sooner.

**Rate limiting.** Unchanged. The global limiter keys on
`request.user?.id ?? request.ip`, so both new surfaces are limited per account at
`RATE_LIMIT_MAX`. No new bucket: restore is a single indexed `UPDATE` and the
trash listing is the same bounded index scan the list has always been. F-011
makes that limit distributed and this feature inherits it.

**CSRF.** `POST /api/todos/:id/restore` is a state-changing `POST`, covered by
the existing `onRequest` origin hook in `src/app.ts` wherever `ALLOWED_ORIGINS`
is populated (everywhere a browser client is served, per ADR 0007) and by
`SameSite=Lax`, which does not send the cookie on a cross-site `POST`.

**Logging.** Todo titles are user content and are not logged, before or after
this change; the delete and restore log lines carry an action and nothing else,
and the sweep logs a count. A log-stream assertion keeps it that way.

**PII.** No new category of personal data is collected. What changes is
retention: content the user asked to delete now persists for up to 30 days, which
is why this feature carries the `pii` tag despite adding no new field about a
person.

## Observability

- **`todos_soft_delete_total{action="deleted"|"restored"|"purged"}`** — a new
  Prometheus counter in `src/plugins/metrics.ts`, passed into
  `registerTodoRoutes` the way `metrics` is passed into `registerSessionRoutes`.
  `purged` is incremented by the number of rows the sweep actually removed, so it
  carries how wide each sweep was. No todo id and no title as a label: one is
  unbounded cardinality, the other is user content. Three readings matter:
  **`restored` climbing relative to `deleted`** is the feature earning its keep
  (users are misclicking delete, which is the premise of the whole thing);
  **`purged` flat at zero more than 30 days after launch** means the sweep never
  runs and the retention window is fiction; **`deleted` climbing while `purged`
  stays near zero over months** is the accumulation the no-scheduler choice
  accepts, and the number to look at if the table grows.
- **One structured log line per operation** —
  `request.log.info({ todo: { action: 'delete' | 'restore' } })`, and
  `{ todo: { action: 'purge', count } }` for a sweep that removed anything. No
  title, ever. `request.log.warn({ err, todo: { outcome: 'sweep_failed' } })` is
  the one that answers "why is `purged` zero".
- **`http_request_duration_seconds{route="/api/todos/:id/restore"}`** comes free
  from the existing `onResponse` hook. The one to watch is the **`DELETE`**
  route's p95: it now carries a bounded purge, so a rise there is the first sign
  of an account with a large expired backlog — and, since the sweep is capped at
  100 rows, the rise is bounded too.
- **Not measured:** a gauge of how many soft-deleted rows exist. It is a
  `COUNT(*)` on every scrape over the table the hot path reads. The counters
  above answer the same question by subtraction, badly but for free.

## Rollout

**No feature flag and no configuration.** The routes and the changed behaviour
ship on in every environment, so the deployed contract matches `openapi.json`
everywhere — the position F-004 and F-009 took. Rejected: a flag toggling soft
delete, which doubles the delete semantics matrix (and the test matrix) for a
change whose rollback is already clean.

**Order.** Merge. One PR, one additive migration applied at container start by
`scripts/docker-entrypoint.sh` before the server boots.

**During the rolling deploy, two delete semantics run at once, and both are
safe.** Old instances still issue `DELETE FROM todos` and destroy the row
outright; new instances set `deleted_at`. The consequences, in full:

- A todo deleted by an old instance during the window is genuinely gone and not
  restorable. That is today's behaviour, for the length of one deploy.
- A todo soft-deleted by a new instance may still appear in a list served by an
  old instance, which does not know the predicate. Transient, self-healing the
  moment the rollout finishes, and visible to one user as a row that reappears
  once.
- No write conflicts either way: the old `DELETE` and the new `UPDATE` touch
  different rows, and an old `DELETE` landing on an already-soft-deleted row
  simply removes it early.

**Rollback at 2am.** Redeploy the previous image. The column is nullable and
unread by the old code, the restore route vanishes with the image, and no
existing column or response was modified — so the migration can and should stay
applied. **The one non-obvious consequence: every todo soft-deleted since the
deploy becomes visible again**, because the old code does not filter on
`deleted_at`. Nothing is lost and nothing errors, but a user may see todos they
deleted reappear. That is the strictly safer direction of the two failure modes —
rollback un-deletes rather than destroys — and it is the reason no
`deleted_at IS NOT NULL` cleanup should ever be run "to tidy up" after a
rollback. Rolling forward again re-hides them, since `deleted_at` was never
cleared.

**Follow-ups this creates:**

- **F-021** — the undo affordance and trash screen (added by this plan). Until it
  ships, the feature has no user-facing surface and the delete button looks
  exactly as permanent as it did before.
- **F-013** — must decide whether the trash is searchable, and must keep the
  predicate out of its index or in its query. See "Backlog split".
- **F-012** — must include `deleted` in the list cache key and must invalidate on
  restore, not only on delete. See "Backlog split".
- **F-015** — must decide whether a data export includes the user's trash.
  Deletion is already handled by the existing cascade.
- **#29** — unfixed, and the composite-cursor fix must keep the new predicate.
- **#11** — the `CREATE INDEX CONCURRENTLY` conflict, routed around again rather
  than fixed; this feature adds no index and explains why above.

**Diff budget.** Estimated ~330 hand-written lines: migration (~15),
`src/db/schema.ts` (~6), `src/routes/todos.ts` (~85: the query parameter, four
`WHERE` clauses, the rewritten delete, the restore route, the sweep),
`src/plugins/metrics.ts` and `src/app.ts` (~15), integration tests (~210), plus a
regenerated `openapi.json` (generated, excluded). Comfortably inside the ~500
guidance, which is why the API is one PR — and F-021 exists rather than a screen
in this one. If it runs over, cut the trash-pagination case and the
`deletedAt`-on-every-response case; **never** the cross-account delete/restore
case, the sweep's account scoping, or the mid-scroll pagination case, which are
this feature's correctness and security properties.
