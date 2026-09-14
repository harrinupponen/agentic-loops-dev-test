-- 0007_audit_events.sql
-- Expand/contract: this migration must leave the CURRENTLY DEPLOYED code working.
-- Additive changes only in the same PR as app code. Drops go in a later PR.
--
-- Purely additive: one new table and nothing else touched. The previously
-- deployed image never reads it, so this migration can and should stay applied
-- through a rollback — undoing it would mean destructively removing this table,
-- which is a migration that has to ship alone anyway.
--
-- There is an expand step and there is NO contract step, now or ever: every
-- column is created with its final type and its final nullability, nothing is
-- backfilled, nothing is later made NOT NULL, nothing is dropped.

CREATE TABLE IF NOT EXISTS audit_events (
  -- Not the primary key on its own; see the composite key below.
  id         uuid NOT NULL DEFAULT gen_random_uuid(),
  -- NOT NULL, deliberately: every row has an owner who can read it, and the
  -- cascade is what makes F-015's account deletion complete for free. A failed
  -- sign-in against an address that matches no account therefore writes no row
  -- at all — see the spec, which rejects a nullable user_id by name.
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- A closed set enforced in TypeScript, NOT by a CHECK constraint. Adding an
  -- action later must not require dropping and recreating a constraint, which
  -- migration-safety.mjs (rightly) classes as destructive and forces into its
  -- own PR. There is exactly one writer and it takes a union type.
  -- See docs/adr/0025-the-audit-log-records-a-closed-set-of-events.md.
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
  -- use, and the same reason: a standalone concurrent index build is
  -- unavailable here (issue #11 — closed as completed, but the guard still
  -- carries the rule and src/db/migrate.ts still wraps every file in a
  -- transaction) and unnecessary anyway. Note that the guard matches on text,
  -- so even naming the statement in a comment fails the build.
  PRIMARY KEY (user_id, created_at, id)
);

-- Four columns and no more. No `details jsonb`, no IP address, no user agent,
-- no email address: refused by name in ADR 0025 so that adding any of them is a
-- decision someone has to argue for rather than a diff nobody notices.
