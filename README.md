# agentic-todo

A deliberately over-engineered todo application, built to practise production
engineering and agent-driven development. The product is small on purpose. The
harness around it is the point.

There are no AI features in the application. AI is how it gets built.

## What is here

| Layer | What it does |
| --- | --- |
| **Application** | Fastify + Postgres + Drizzle. Sessions, todo CRUD, keyset pagination, rate limiting, metrics, graceful shutdown |
| **Verification** | Vitest against real Postgres, Playwright E2E, k6 load thresholds, OpenAPI contract check |
| **Guards** | Test-integrity, expand/contract migration safety, sensitive-path human gate, secret scanning |
| **Pipeline** | Tiered GitHub Actions, normalised failure output, staging → promote → production with rollback |
| **Loop** | `AGENTS.md`, four agent roles, machine-readable backlog, two mandatory human gates |

## Getting started

Nothing here has been installed or run yet — there is no lockfile, no
`openapi.json`, and the test baseline is zero. **Start with
`docs/GETTING-STARTED.md`**, which walks Phase 0 in order with a verification
step for each stage. In Claude Code, `/bootstrap` runs it.

Once past that:

```bash
make setup           # deps, Playwright browsers, .env
make dev             # Postgres + migrations + watch server
curl localhost:3000/healthz
```

Then run the full pipeline the way CI does:

```bash
make ci
```

That command is the contract. If it is green locally it is green in CI, and
agents are instructed to run it before every push.

## Layout

```
src/            application — routes/, plugins/, lib/, db/
tests/          unit/ (pure logic) and integration/ (real Postgres)
e2e/            Playwright, over real HTTP
load/           k6 smoke and soak, thresholds enforced in CI
drizzle/        plain SQL migrations, append-only
scripts/ci/     the gates: summariser, test integrity, migration safety
specs/          features.yaml backlog + one spec per feature
.agents/        role descriptions and the loop state machine
.claude/        Claude Code subagents, slash commands, permissions
docs/adr/       architecture decisions
docs/GETTING-STARTED.md   Phase 0, step by step
docs/ROADMAP.md           loop maturity phases
docs/deployment-sevalla.md
AGENTS.md       operating manual — every agent reads this first
```

## Roadmap

`specs/features.yaml` is what the app does. `docs/ROADMAP.md` is how much
autonomy the agents have — five phases from hand-built skeleton to parallel
features, with the rule that nothing gets automated until it has been done
manually three times.

## Setup checklist before the loop runs

1. Replace `@your-github-handle` throughout `.github/CODEOWNERS`.
2. Branch protection on `main`: require the `CI passed` check, require a pull
   request, require review from Code Owners, disallow force push, **and do not
   allow administrators to bypass** — that includes you.
3. Create the labels: `gh label create` for each entry in `.github/labels.yml`.
4. Create the `staging` and `production` GitHub environments; add required
   reviewers to `production`. That approval button is your deploy gate.
5. Set up Sevalla and add the secrets and variables it needs — see
   `docs/deployment-sevalla.md`. Pin the Sevalla action to a commit SHA while
   you are there.
6. `npm install && npm run openapi:dump && npm run ci:baseline` to seed the
   generated files, then commit them.

## Two things worth knowing

**The gates are load-bearing.** `scripts/ci/` and `.github/` are CODEOWNERS-
protected because the most likely way an agent turns a red build green is by
changing what "green" means. The guards catch skipped tests, edited migrations,
and lowered thresholds. Do not grant admin bypass to the loop.

**Scale is a teaching device here.** A todo app on one Postgres and one app
server handles a few thousand concurrent users without effort. The one real
limit to watch is `DATABASE_POOL_MAX × instances` against your Postgres
`max_connections` — see `docs/deployment-sevalla.md`. The value is in
the practices — load thresholds in CI, connection pool limits, keyset
pagination, expand/contract migrations, canary deploys with rollback — not in
the traffic. Treat Redis caching and read replicas (F-011, F-012) as deliberate
practice rather than something this workload demands.

## The loop

See `.agents/README.md` for the state machine. In short: the planner drafts a
design, **a human approves it**, the implementer opens a PR, the fixer works
through CI failures with a hard cap of five attempts, the reviewer checks the
diff in a fresh context, and **a human merges**. Sensitive paths pick up a
blocking `needs-human` label automatically.
