-- 0005_session_metadata.sql
-- Expand/contract: this migration must leave the CURRENTLY DEPLOYED code working.
-- Additive changes only in the same PR as app code. Drops go in a later PR.
--
-- Purely additive: two nullable columns on `sessions`. Nothing is dropped,
-- renamed, or made NOT NULL here, so this ships legally alongside src/ changes
-- and stays applied through a rollback — the previously deployed image selects
-- neither column.

-- The only session identifier that ever leaves the server. `sessions.id` is
-- sha256(token), a verifier for a live credential, so it is never serialised
-- into a response, a URL, a log line, or a metric label.
-- See docs/adr/0014-sessions-have-a-public-id.md.
-- Nullable with no default is a catalogue-only change in Postgres 17: no table
-- rewrite and no long lock.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS public_id uuid;

-- The device string, truncated to 256 characters at write time and stored raw.
-- Nullable forever, not just until the contract migration: a client that sends
-- no User-Agent has none, and so does every row written before this shipped.
-- No IP address, no geolocation — see
-- docs/adr/0015-a-session-records-the-device-not-the-location.md.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_agent text;

-- New rows only; setting a default on an existing column rewrites nothing.
-- This is what keeps rows written by OLD instances mid-rollout addressable:
-- during the rolling deploy the old image inserts without naming the column and
-- the default fills it in.
ALTER TABLE sessions ALTER COLUMN public_id SET DEFAULT gen_random_uuid();

-- Backfill. Takes row locks and writes new row versions, but readers are never
-- blocked, so authenticated requests served by the old image keep working
-- throughout. Combined with the default above, no row has a NULL public_id from
-- the moment this migration commits.
UPDATE sessions SET public_id = gen_random_uuid() WHERE public_id IS NULL;

-- No new index, deliberately. Both new query paths are `WHERE user_id = $1 AND
-- ...`, and sessions_user_id_idx has existed since 0001_init.sql; it reduces the
-- scan to one account's handful of rows before public_id or expires_at is looked
-- at. public_id needs no unique constraint either: gen_random_uuid() plus a
-- user_id-scoped lookup makes a collision both astronomically unlikely and
-- harmless. See ADR 0014.

-- Contract step, deferred to a LATER migration-only PR: public_id gains a
-- not-null constraint there. It cannot ship here, because scripts/ci/
-- migration-safety.mjs (rightly) refuses destructive DDL in the same PR as
-- application code. The DDL is spelled out in the feature spec rather than
-- quoted here, since the guard matches on file contents and a comment would
-- trip it. It converts a guarantee this migration already provides — default
-- plus backfill — into one the database enforces; nothing depends on it.
