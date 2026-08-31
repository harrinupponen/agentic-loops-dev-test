# 3. Expand/contract migrations, enforced in CI

Date: 2026-08-29
Status: Accepted

## Context

Deploys are rolling: for a period, old and new application versions run against
the same database simultaneously. A migration that drops a column the old version
still reads causes errors for every request served by an old instance until the
rollout finishes — and makes rollback impossible, because the previous image can
no longer talk to the schema.

This is the single most common way a small application takes real downtime, and
it is exactly the kind of mistake an agent makes while confidently following a
spec that says "rename the column".

## Decision

All schema changes follow expand/contract, split across separate PRs and deploys:

1. **Expand** — add the new column or table. Additive only. Deploy.
2. **Migrate** — write to both old and new; backfill existing rows. Deploy.
3. **Switch** — read from the new. Deploy.
4. **Contract** — drop the old. Deploy.

`scripts/ci/migration-safety.mjs` enforces the parts that can be checked
mechanically: applied migrations are immutable, destructive DDL may not ship in
the same PR as `src/` changes, and `CREATE INDEX` must be `CONCURRENTLY`.

Migrations are plain SQL applied by `scripts/migrate.ts` under a Postgres
advisory lock, so concurrent deploys cannot race.

## Consequences

A rename takes four PRs instead of one. That is the price of never taking
downtime for a schema change and of keeping every deploy rollback-safe.

Agents cannot express the dangerous version of a change even when a spec asks
for it, because CI rejects the diff shape rather than relying on review to catch it.
