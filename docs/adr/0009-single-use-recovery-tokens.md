# 9. Out-of-band recovery tokens are single-use rows, one per account

Date: 2026-09-07
Status: Accepted

## Context

F-004 needs a credential a user can present instead of their password. F-005
(email verification) needs the same shape, and F-009's "revoke a session" and any
future invite or magic-link flow are near neighbours. Whatever F-004 does will be
copied, so it is worth deciding once.

The existing precedent is `sessions`: 32 random bytes, base64url to the client,
sha256 in the database, and the raw value never persisted or logged. That part is
settled and is simply followed.

What is not settled is the row lifecycle, and the choices interact with three
local constraints:

- `scripts/ci/migration-safety.mjs` rejects a new `CREATE INDEX` that is not
  `CONCURRENTLY`, while `src/db/migrate.ts` wraps each migration in a transaction
  where Postgres refuses `CONCURRENTLY` (issue #11). A design that needs a
  secondary index is blocked on unrelated work.
- AGENTS.md requires a supporting index for every new query path, so "just scan
  it" is not available either.
- Single-use has to be an invariant, not a code path. It is the check whose
  absence turns a reset flow into an account-takeover flow, and it is the check
  most easily lost in a later refactor.

## Decision

A recovery token is one row keyed by the account it belongs to.

```sql
CREATE TABLE <purpose>_tokens (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
```

Four consequences follow from the shape, and they are the point of it:

1. **At most one live token per account**, guaranteed by the primary key rather
   than by a query someone has to remember to write. Issuing is an upsert on
   `user_id`; the previous token stops existing.
2. **Consuming is `DELETE ... WHERE token_hash = $1 RETURNING ...`.** Single-use is
   the deletion, executed as one atomic statement. There is no `used_at` column to
   check, no way for two concurrent confirmations to both win, and no spent
   credential left in the table.
3. **No secondary index.** The primary key serves issuing, the unique constraint
   serves consuming, and both are created with the table while it is empty. Issue
   #11 is routed around, not resolved.
4. **No retention job.** The table is capped at one row per account. Stale rows are
   overwritten by the next request and removed with the account by the cascade.

A cooldown, when one is wanted, is expressed as a `WHERE` clause on the upsert's
`DO UPDATE` — the row already carries `created_at`. No row returned means "issued
too recently"; the caller does nothing further and reports success anyway.

The consuming endpoint hashes any submitted password _before_ it looks the token
up, so a valid and an invalid token cost the same wall-clock time, and it destroys
every session for the account in the same transaction as the credential change.

## Consequences

A user who requests two resets and clicks the **first** link is told the token is
invalid. This is the visible cost of the invariant, it matches what major
providers do, and it is the safer of the two failure modes. It must be said out
loud in the UI copy when F-017 ships the screens.

"Expired" and "unknown" stay distinguishable to the caller, because only someone
already holding a token can reach either answer; neither reveals anything about an
account. The expired branch rolls its transaction back, so the dead row survives
until the next request overwrites it.

The design does not extend to multi-device or multi-token flows — an account
cannot have two live invitations, for example. If that requirement ever appears it
needs a different key and a new ADR, and it will also need issue #11 resolved
first, because it will need an index.

Nothing here removes the need for rate limiting. The invariants make a token safe
to hold; they do not make the endpoint safe to hammer.
