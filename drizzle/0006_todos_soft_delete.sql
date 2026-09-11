-- 0006_todos_soft_delete.sql
-- Expand/contract: this migration must leave the CURRENTLY DEPLOYED code working.
-- Additive changes only in the same PR as app code. Drops go in a later PR.
--
-- Purely additive: one nullable column on `todos`. Nothing is dropped, renamed,
-- or made NOT NULL, so this ships legally alongside src/ changes and stays
-- applied through a rollback — the previously deployed image never selects it.

-- NULL means live, a timestamp means deleted at that moment. Nullable with no
-- default is a catalogue-only change in Postgres 17: no table rewrite, no long
-- lock, and no backfill, because NULL already means exactly "not deleted" for
-- every row that exists.
-- See docs/adr/0016-soft-delete-is-a-nullable-timestamp.md.
ALTER TABLE todos ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- No new index, deliberately. The list query's access path is unchanged —
-- `WHERE user_id = $1 [AND created_at < $cursor] ORDER BY created_at DESC` is
-- still served by todos_user_id_created_at_idx from 0001_init.sql — and
-- `deleted_at IS [NOT] NULL` is a filter over rows that index has already
-- narrowed to one account, not a new access path. The partial index that would
-- be the textbook improvement needs CREATE INDEX CONCURRENTLY, which
-- src/db/migrate.ts cannot run inside its transaction (issue #11).

-- NO contract step, now or ever. Unlike 0005's public_id, `deleted_at` stays
-- nullable permanently: NULL is the meaningful "live" value this design relies
-- on, not a temporary state before a backfill. This is the whole migration.
