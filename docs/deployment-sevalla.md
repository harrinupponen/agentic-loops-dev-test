# Deploying on Sevalla

Sevalla is Kinsta's PaaS: Kubernetes on Google Cloud, Cloudflare at the edge,
managed Postgres alongside. It builds from a Git repo or a Docker image, and it
has an official GitHub Action and CLI, so the loop stays inside GitHub.

Three things differ from a VM-style target, and each one changed a decision here.

## 1. Sevalla builds the image, not CI

Point the application at this repo with **build strategy: Dockerfile**. Sevalla
fetches the commit, builds, pushes to its own registry, and rolls out.

That means CI and Sevalla produce two separate builds of the same Dockerfile.
`.github/workflows/deploy.yml` still builds and Trivy-scans an image so the
vulnerability gate survives, but that image is discarded — it exists to be
scanned, not shipped.

**Pin the base image by digest** to keep the two builds equivalent:

```bash
docker buildx imagetools inspect node:22-bookworm-slim --format '{{.Manifest.Digest}}'
# then in the Dockerfile: FROM node:22-bookworm-slim@sha256:<digest> AS deps
```

Without the pin, "scanned in CI" and "running in production" can be different
images, and the gate quietly stops meaning anything.

## 2. Managed Postgres is private by default

Sevalla databases expose an internal connection (in-cluster, fast, not routable
from outside) and an external one that is **disabled by default**. GitHub
Actions cannot reach the internal address.

So migrations moved from a pipeline step into the container entrypoint
(`scripts/docker-entrypoint.sh`): every instance runs `node dist/db/migrate.js`
before starting the server.

This is safe here because of two things that were already in place:

- `runMigrations` takes a Postgres advisory lock, so several instances starting
  at once serialise rather than race.
- ADR 0003, enforced by `scripts/ci/migration-safety.mjs`, forbids destructive
  DDL shipping alongside `src/` changes. Every migration reaching production is
  additive, so the old revision keeps serving correctly during rollout.

A failed migration exits non-zero, the container never passes its health check,
and Sevalla holds the previous revision. You get a failed deploy instead of a
broken one.

**The alternative**, if you would rather migrations be a visible pipeline step:
enable external connections on the database and run `npm run db:migrate` from
the runner before the deploy step. The cost is a publicly reachable database
endpoint protected by a password alone. Use the internal path unless you have a
specific reason not to.

## 3. Promotion replaces the second build

Sevalla pipelines promote a built artifact between environments without
rebuilding. The workflow deploys to staging, runs the Playwright suite against
the live staging URL, then promotes that exact artifact to production. What
ships is what was tested.

The `production` GitHub environment sits in front of the promote job. Required
reviewers there are your deploy gate.

## Setup

**Database** — create a Postgres instance in the same region as the app. Copy the
internal connection string.

**Staging app** — add an application from this repo, branch `main`, build
strategy Dockerfile, automatic deployment **off** (the workflow triggers deploys;
leaving it on gives you two deploys per merge). Set a health check path of
`/readyz` on the web process — without it, rollouts are not zero-downtime. Add an
internal connection to the database.

**Production app** — same, in the same region so internal networking works.

**Pipeline** — create one with staging as the source stage and production as the
target.

**Environment variables** on each app:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | internal connection string |
| `COOKIE_SECRET` | `openssl rand -base64 48`, different per environment |
| `NODE_ENV` | `production` |
| `TRUST_PROXY` | `true` (requests arrive through Cloudflare) |
| `ALLOWED_ORIGINS` | that environment's public URL |
| `PORT` | `3000` |
| `DATABASE_POOL_MAX` | see the note below |

**GitHub secrets:** `SEVALLA_TOKEN` (from app.sevalla.com/api-keys).

**GitHub variables:** `SEVALLA_STAGING_APP_ID`, `SEVALLA_PRODUCTION_APP_ID`,
`SEVALLA_PIPELINE_ID`, `STAGING_URL`, `PRODUCTION_URL`.

Then pin the Sevalla action to a SHA, per the comment at the top of
`deploy.yml`. It runs with your API token; a mutable tag should not.

## Connection pool sizing

The one number that will actually bite you at scale. Each instance opens up to
`DATABASE_POOL_MAX` connections, and Postgres has a hard `max_connections`.

```
DATABASE_POOL_MAX × max_instances ≤ max_connections − 5
```

Leave the headroom for migrations and for you connecting with psql. Exceeding it
produces `too many clients already`, which looks like a mysterious partial
outage under load rather than a configuration error. Check the limit for your
database plan and set the pool from that, not the other way round.

If you eventually need more instances than connections allow, add PgBouncer in
transaction mode rather than raising the pool.

## Worth using later

**Preview environments.** Sevalla can spin up a live app per pull request. That
would let the reviewer agent check behaviour against a running deployment rather
than only reading a diff — a real upgrade to the loop. Costs money per open PR,
so it is worth deferring until the loop is stable.

**MCP server.** Sevalla ships one for its API. An agent could read deployment
status and logs directly. Read-only is fine; think hard before giving an agent
deploy or database credentials, since none of the CI guards apply to an action
taken outside a pull request.
