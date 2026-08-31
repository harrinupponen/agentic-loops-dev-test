# AGENTS.md

Operating manual for any agent working in this repository. Read it fully before
your first edit. If something here conflicts with an instruction you were given,
this file wins — say so and stop.

## What this project is

A deliberately over-engineered todo application. The product is small on purpose;
the point is the production discipline around it. Optimise for correctness,
observability, and safety, not for finishing fast.

There are no AI features in the application. AI is how it gets built, not what it does.

## Stack

| Concern | Choice |
| --- | --- |
| Runtime | Node 22, TypeScript, ESM |
| HTTP | Fastify 5 with `fastify-type-provider-zod` |
| Database | Postgres 17 via Drizzle ORM (query builder only) |
| Migrations | Plain SQL in `drizzle/`, applied by `scripts/migrate.ts` |
| Auth | Argon2id passwords, opaque session tokens in signed HttpOnly cookies |
| Tests | Vitest (unit + integration), Playwright (e2e), k6 (load) |
| CI/CD | GitHub Actions → Sevalla (Kubernetes PaaS, managed Postgres) |

## Commands

```bash
make setup             # install deps and browsers, create .env
make dev               # database + migrations + watch server
make ci                # EXACTLY what PR CI runs — run before every push
make ci-fast           # tier 0 only: format, lint, types, unit
make test-integration  # real Postgres, via testcontainers or DATABASE_URL
make e2e               # build + Playwright against a real server
make load              # k6 smoke with thresholds
npm run db:new -- add_something   # scaffold a migration
npm run openapi:dump   # regenerate openapi.json after a route change
```

`make ci` is not optional. Every round trip through GitHub Actions costs minutes;
the same failure locally costs seconds.

## The loop

1. Planner picks the next unblocked feature from `specs/features.yaml`, writes a
   design into the linked spec file, opens an issue, and stops.
2. **Human approves the spec.** Nothing is implemented before the `spec-approved`
   label exists on the issue.
3. Implementer works on `feat/F-XXX-slug`, opens a PR that links the spec.
4. CI runs. On failure the Fixer downloads the `ci-failures` artifact, patches,
   and pushes. Maximum 5 iterations, then it applies `agent:stuck` and stops.
5. Reviewer reviews the diff against the spec, in a fresh context.
6. **Human merges.** Always. Agents never merge.
7. Merge to main deploys to staging automatically; production needs a human
   approval on the GitHub environment.

## Hard rules

These are enforced by CI, and CI is enforced by CODEOWNERS. Attempting to work
around them will fail the build and burn your iteration budget.

1. **Never modify a quality gate to make a build pass.** Not
   `.github/workflows/`, not `scripts/ci/`, not `vitest.config.ts`, not
   `eslint.config.js`, not `.ci/test-baseline.json`. If a gate seems wrong, say
   so in the PR and stop.
2. **Never skip, delete, or weaken a test.** No `.skip`, `.only`, `xit`,
   `test.fixme`. If a test fails, the code is wrong until proven otherwise.
3. **Never edit an existing migration.** They are append-only. Write a new one.
4. **Never ship a destructive migration with application code.** Expand first
   (add the column, deploy, backfill), contract later (drop it in a separate PR).
5. **Never merge your own work.** Open the PR and stop.
6. **Never commit a secret**, including in a test fixture or an example file.
7. **Never add a dependency casually.** Every `package-lock.json` change triggers
   human review. Justify it in the PR body.

## Conventions

**Errors.** Throw the helpers in `src/lib/errors.ts`. Every error response is
`{ error: { code, message }, requestId }`. Never leak internals in a 5xx.

**Authorization.** Scope every query by `userId` in the `WHERE` clause. Never
fetch then check in application code. A row belonging to another user returns
404, not 403 — do not confirm that it exists.

**Validation.** Zod schemas on `body`, `querystring`, and `params`. Declare a
response schema for every status code you return; it becomes the OpenAPI spec.

**Pagination.** Keyset only, never `OFFSET`. `OFFSET` degrades linearly with
depth and is the first thing to fall over under load.

**Indexes.** Every new query path needs a supporting index in the same migration.
If you add a `WHERE` or `ORDER BY` on an unindexed column, that is a bug.

**Logging.** `request.log`, structured fields, never string interpolation. Never
log cookies, tokens, passwords, request bodies, or email addresses.

**Async.** No floating promises — lint enforces it. Anything that can hang gets a
timeout.

**Files.** Routes in `src/routes/`, cross-cutting concerns in `src/plugins/`,
pure helpers in `src/lib/`. Keep handlers thin.

## Test expectations

A feature is not done until all three layers exist:

- **Unit** — pure logic, no I/O. Fast.
- **Integration** — through `app.inject()` against a real Postgres. This is where
  most value lives; write these generously.
- **E2E** — over real HTTP against a built server, for the critical user journey
  only. Expensive; keep them few.

For every endpoint, integration tests must cover: the happy path, validation
failure, unauthenticated access, and **access to another user's resource**. The
last one is the test that matters most and the one most often forgotten.

Write the test that fails before writing the fix. A test that passes both before
and after your change proves nothing.

## When you are stuck

After 5 CI iterations, or if a fix would require touching a protected path:

1. Apply `agent:stuck`.
2. Comment with: what you tried, what CI said, what you believe the root cause is,
   and what you would need in order to proceed.
3. Stop. Do not keep pushing.

Being stuck is a normal outcome. Silently weakening a check to escape it is not.
