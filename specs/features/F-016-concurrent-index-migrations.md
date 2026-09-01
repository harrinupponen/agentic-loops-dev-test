# F-016 · Reconcile CREATE INDEX CONCURRENTLY with the transactional migration runner

> Status is tracked in `specs/features.yaml`, not here.
>
> Backlog stub filed by the F-007 implementer. Design is for the Planner.

## Problem

`scripts/ci/migration-safety.mjs` rejects any new migration containing a plain
`CREATE INDEX`, requiring `CREATE INDEX CONCURRENTLY`. But `src/db/migrate.ts`
runs each migration file inside `BEGIN`/`COMMIT`, and Postgres refuses
`CREATE INDEX CONCURRENTLY` inside a transaction block. So a migration that adds
an index passes CI and then fails at container start, after the previous
deploy's image has already been replaced. No feature has hit this yet — F-007
needed no index — but the next one that adds a `WHERE` or `ORDER BY` column
will, and it will find out during a deploy rather than in review.

## Scope

**In scope**

- Making it possible to add an index in a migration that both satisfies the CI
  guard and applies successfully at deploy time.

**Out of scope**

- Weakening or removing the guard to make the problem disappear.
- Retrofitting any existing index; `0001_init.sql` is applied and immutable.

## Design

<!-- Planner: options include a per-file opt-out marker that runs the file
     outside a transaction, splitting concurrent-index migrations into their own
     runner phase, or building indexes in a separate post-deploy job. Each
     changes deploy-time failure semantics (a failed CONCURRENTLY build leaves
     an INVALID index behind), so the retry story needs to be part of it. -->

## Acceptance criteria

- [ ] A migration that adds an index passes `migration-safety.mjs` and applies
      cleanly against a real Postgres via the normal migration entrypoint
- [ ] A failed concurrent index build leaves the system in a documented,
      recoverable state
