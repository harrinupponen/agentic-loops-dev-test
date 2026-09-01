-- 0002_idempotency_keys.sql
-- Expand/contract: this migration must leave the CURRENTLY DEPLOYED code working.
-- Additive changes only in the same PR as app code. Drops go in a later PR.
--
-- Purely additive: one new table. The previously deployed image ignores it, so
-- this migration can stay applied through a rollback.

CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key             text NOT NULL,
  -- sha256 of method + route + canonical JSON body.
  fingerprint     text NOT NULL,
  status          text NOT NULL CHECK (status IN ('in_progress', 'completed')),
  response_status integer,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  -- Scoped per user: one account can never collide with, or observe, another's
  -- key. Both query paths are served by this primary key — claim/lookup uses
  -- the full key, the retention sweep uses its leading column — so this
  -- migration deliberately adds no index.
  PRIMARY KEY (user_id, key)
);
