# 16. Soft delete is a nullable timestamp on the row

Date: 2026-09-11
Status: Accepted

## Context

F-010 makes deleting a todo reversible. Whatever shape that takes will be copied:
F-013 (search), F-012 (caching) and F-015 (export and account deletion) all read
the same table, and any future entity that needs an undo will follow whatever
`todos` did.

Three shapes were available.

1. **A nullable `deleted_at timestamptz` on the row.** The row never moves;
   deletion is a column.
2. **An archive table.** `DELETE ... RETURNING` into `deleted_todos` on delete,
   and the reverse on restore.
3. **An event log.** The current state of a todo is a fold over its history.

Local constraints narrowed the choice before preference did. `src/db/migrate.ts`
wraps each migration in a transaction, where Postgres refuses `CREATE INDEX
CONCURRENTLY`, while `scripts/ci/migration-safety.mjs` requires it — so any
design needing a new index is blocked on issue #11. Expand/contract (ADR 0003)
means a change that can be expressed as one additive, nullable column costs one
migration and no contract step, while anything else costs several.

## Decision

Deletion is `todos.deleted_at`: `NULL` means live, a timestamp means deleted at
that moment. The column is nullable permanently — `NULL` is a value this design
relies on, not a gap awaiting a backfill — so there is no `SET NOT NULL` contract
step, ever.

Three rules come with it, and they are the part that matters:

1. **The table's default meaning is "live".** Every read says
   `AND deleted_at IS NULL` in its `WHERE`, at the call site, in SQL. There is no
   view, no ORM-level default scope, and no base query helper that applies the
   predicate invisibly. A reviewer reading one query can see which rows it means.
2. **Restore clears the column in place.** Same id, same `created_at`, same
   title, same completion state. Nothing is copied, re-keyed, or re-stamped, so
   no other table's reference to a todo can be invalidated by a delete/restore
   cycle, and a restored row returns to its original position in the keyset
   ordering rather than jumping to the top.
3. **Writes must exclude deleted rows too, not just reads.** A soft-deleted todo
   cannot be edited; `PATCH` carries the same predicate and answers `404`. The
   only transition out of the deleted state is restore.

## Consequences

The migration is one `ADD COLUMN`, catalogue-only, with no backfill and no
contract step, and a rollback that leaves the column applied is safe — the
previous image simply does not select it, so deleted rows become visible again
rather than erroring. That asymmetry is deliberate: the failure mode of this
design under rollback is "too much is visible", never "data is gone".

The cost is spread over every future reader of `todos`. "The todos table" no
longer means "the user's todos" — it contains rows the user believes are gone,
and any feature that queries the table without the predicate will surface them.
A full-text index that is not partial will match deleted titles; a cache key that
does not include the deleted filter will serve the trash to the live view; an
export that ignores the column will include content the user deleted. Each of
those is a real bug this ADR makes possible, which is why the predicate is
required to be visible in every query rather than hidden behind a view.

No new index is added. The existing `todos_user_id_created_at_idx` still drives
every list query; `deleted_at` is a filter over rows already narrowed to one
account, not a new access path. A partial index would be the textbook improvement
and is available the moment issue #11 is resolved — it is an optimisation, not a
correctness requirement.

Rejected, for the record. The **archive table** duplicates the schema and every
column added to it afterwards, turns one `UPDATE` into a two-statement
transaction in each direction, and makes "does this id exist?" a question about
two tables. The **event log** is a different application; nothing here needs the
history of a todo, and the cost is paid on every read forever.

This ADR governs `todos` only. If a second entity ever needs soft delete it
should follow this shape, but the decision to give it one is that feature's, not
this one's.
