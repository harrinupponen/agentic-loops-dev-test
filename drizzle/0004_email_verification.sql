-- 0004_email_verification.sql
-- Expand/contract: this migration must leave the CURRENTLY DEPLOYED code working.
-- Additive changes only in the same PR as app code. Drops go in a later PR.
--
-- Purely additive: one nullable column and one new table. The previously
-- deployed image selects neither, so this migration can stay applied through a
-- rollback and there is no contract step.

-- Nullable, no default, and deliberately NOT backfilled: existing accounts stay
-- NULL because nobody proved control of those mailboxes, and a column holding
-- one invented value can never be trusted for the enforcement decision it
-- exists to support. See docs/adr/0011-email-verification-is-advisory.md.
-- Nullable-with-no-default is also a catalogue-only change in Postgres 17: no
-- table rewrite and no long lock.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;

CREATE TABLE IF NOT EXISTS email_verification_tokens (
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
