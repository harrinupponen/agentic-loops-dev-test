-- 0003_password_reset_tokens.sql
-- Expand/contract: this migration must leave the CURRENTLY DEPLOYED code working.
-- Additive changes only in the same PR as app code. Drops go in a later PR.
--
-- Purely additive: one new table. The previously deployed image ignores it, so
-- this migration can stay applied through a rollback.

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  -- One live token per account, enforced by the schema rather than by a query:
  -- issuing is an upsert on this key, so the previous token stops existing.
  -- See docs/adr/0009-single-use-recovery-tokens.md.
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- sha256 of the opaque token, exactly as sessions.id stores a session token.
  -- The raw token is never persisted, so a database leak yields no live tokens.
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
  -- No standalone secondary index here, deliberately. Both access paths are
  -- served by constraint indexes built with the table: issuing uses the
  -- primary key (INSERT ... ON CONFLICT (user_id)), consuming uses the unique
  -- constraint (DELETE ... WHERE token_hash = $1). This also routes around
  -- issue #11, where the migration guard requires CONCURRENTLY but
  -- src/db/migrate.ts runs each file inside a transaction, which forbids it.
);
