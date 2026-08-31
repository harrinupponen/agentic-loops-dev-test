# Getting started — Phase 0

Nothing in this repo has been installed or run. There is no `package-lock.json`,
no `openapi.json`, and the test baseline is zero. This document gets you from
that to a green pipeline and a first production deploy.

Do it in order. Each step has a verification command; a later step failing
because an earlier one was half-done is genuinely hard to diagnose.

Steps marked **HUMAN** need a decision or a credential and cannot be automated.

---

## 1. Install and lock

```bash
npm install
```

The dependency versions in `package.json` are ranges chosen without a registry
to check against, so expect this to need a nudge. If a package fails to resolve,
`npm install <name>@latest` for the specific one rather than deleting the
lockfile and starting over.

`@node-rs/argon2` is a native module and the most likely thing to complain. On
Linux and macOS it ships prebuilt binaries.

**Verify:** `package-lock.json` exists and `npx tsc --noEmit` runs (errors are
fine at this point — you are checking that TypeScript resolves the packages).

---

## 2. Database up, migration applied

```bash
cp .env.example .env
# generate a real secret and put it in .env
openssl rand -base64 48

docker compose up -d db
npm run db:migrate
```

**Verify:**

```bash
docker compose exec db psql -U app -d app -c '\dt'
```

You should see `_migrations`, `users`, `sessions`, and `todos`.

---

## 3. Seed the generated files

Two files are gates but do not exist yet, so their checks currently fail:

```bash
npm run openapi:dump    # writes openapi.json from the route schemas
```

**Verify:** `npm run openapi:check` passes.

---

## 4. Get `make ci` green

```bash
make ci
```

This is the real Phase 0 milestone. Fix whatever it surfaces. The most likely
categories, roughly in order:

- **Type errors** from version drift in Fastify or Drizzle typings
- **Testcontainers** needing a running Docker daemon
- **Lint** rules firing on code written without a resolver

Fix the code, not the config. If a rule seems genuinely wrong for this project,
change it deliberately and commit that as its own decision — but do it now,
consciously, while you are the one holding the pen. Once agents are running, the
config is frozen behind CODEOWNERS for a reason.

**Verify:** `make ci` exits 0.

---

## 5. Record the baseline

```bash
mkdir -p .ci/reports
npx vitest run --reporter=default --reporter=json --outputFile.json=.ci/reports/vitest-all.json
npm run ci:baseline
```

**Verify:** `.ci/test-baseline.json` shows a non-zero `testCount`. From here the
count can only go up without human review.

---

## 6. E2E and load, locally

```bash
npx playwright install --with-deps chromium
make e2e
```

Then, with the server running (`npm run build && npm start` in another shell):

```bash
brew install k6      # or your platform's equivalent
make load
```

The k6 thresholds are guesses about your hardware. If they fail on a healthy
machine, adjust them **now** with a note explaining the number. Do not leave a
threshold you know is wrong — a gate nobody trusts gets ignored, and then it
protects nothing.

**Verify:** both pass.

---

## 7. **HUMAN** — GitHub setup

```bash
git init && git add -A && git commit -m "chore: initial scaffold"
gh repo create agentic-todo --public --source=. --push
```

Public matters: Actions minutes are unlimited on public repos and metered on
private ones, and agent-driven development burns through a private allowance
quickly.

Then:

1. Replace `@your-github-handle` throughout `.github/CODEOWNERS`.
2. Create the labels:
   ```bash
   gh label create needs-human --color B60205 --description "Touches a sensitive path"
   gh label create spec-approved --color 0E8A16 --description "Design approved; implementation may start"
   gh label create agent:stuck --color 5319E7 --description "Iteration cap reached"
   # ...and the rest from .github/labels.yml
   ```
3. Branch protection on `main`:
   - Require a pull request before merging
   - Require status check **`CI passed`**
   - Require review from Code Owners
   - Disallow force push and deletion
   - **Do not allow administrators to bypass.** Including you. An agent cannot
     use your bypass, but you can, at 1am, and that is exactly when the gates
     matter most.

**Verify:** push a trivial branch, open a PR, watch CI run and the `CI passed`
check appear as required.

---

## 8. **HUMAN** — Sevalla

Follow `docs/deployment-sevalla.md` in full. In short: a Postgres instance, a
staging app and a production app from this repo (build strategy: Dockerfile,
health check path `/readyz`, automatic deploys **off**), a pipeline connecting
them, and the environment variables each app needs.

Then in GitHub: the `SEVALLA_TOKEN` secret, the app/pipeline id variables, and
`staging` plus `production` environments with required reviewers on production.

While you are there, pin the Sevalla action to a commit SHA — the workflow
header has the command.

**Verify:** merge a trivial PR to `main`, watch it reach staging, approve the
production gate, and confirm `/healthz` responds on the production URL.

---

## 9. Verify the guards actually bite

The whole safety model rests on these. Test them once, deliberately, before you
trust them:

```bash
git checkout -b test/guards

# 1. Skip a test
sed -i '' 's/  it(/  it.skip(/' tests/unit/session.test.ts

# 2. Edit an applied migration
echo "-- tampering" >> drizzle/0001_init.sql

git commit -am "test: confirm the guards fire" && git push -u origin test/guards
gh pr create --fill
```

Expect: the `guards` job fails on both counts, and `needs-human` is applied
automatically because the diff touches `drizzle/`.

Then close the PR without merging and delete the branch. A guard you have never
seen fire is a guard you are only assuming works.

---

## You are done with Phase 0 when

- `make ci` is green locally and in CI
- `main` is protected and you cannot bypass it
- A commit reaches production through the pipeline
- You have watched the guards reject a bad PR

Next: `docs/ROADMAP.md`.
