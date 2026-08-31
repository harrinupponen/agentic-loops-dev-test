# Roadmap

Two roadmaps run in parallel, and it is worth keeping them apart.

**The feature backlog** — `specs/features.yaml` — is what the application does.
The loop consumes it.

**The loop maturity phases** below are how much autonomy the agents have. That
is what this document tracks, and it is the thing you are actually building.

The governing rule: **only automate a step after you have done it manually three
times.** Automating earlier builds elaborate machinery around a workflow that
turns out to be wrong.

---

## Phase 0 — Walking skeleton (you, by hand)

**Goal:** every convention exists and is verified end to end before an agent
copies it fifty times.

See `docs/GETTING-STARTED.md`. Do not delegate this phase. The conventions you
set here — error shape, test layout, authorization pattern — become the template
every agent imitates. A sloppy skeleton produces fifty sloppy features.

**Exit:** `make ci` green, `main` protected, a commit in production, guards
observed rejecting a bad PR.

---

## Phase 1 — One feature, fully supervised

**Goal:** find out where agents actually fail on _this_ codebase, before adding
machinery to handle failures you have only imagined.

Build **F-006 (Web UI)** or **F-007 (Idempotency keys)** first — not F-004.
Password reset touches auth and PII, which means every PR trips `needs-human`
and you review everything anyway. Save it for when the loop is trustworthy.

Run each step yourself, in one session, approving everything:

```
/next-feature          → read the design carefully, edit it, then label spec-approved
/implement F-007       → watch it work; interrupt when it goes sideways
                       → push, watch CI, fix failures by hand
/review-pr <n>         → read the verdict; do you agree?
                       → merge yourself
```

**Watch for:** Did the planner design something you would not have? Did the
implementer scope-creep? Did the reviewer catch anything real, or only produce
plausible-sounding checklist output? Did CI catch something the reviewer missed,
or the reverse?

Write down every place you had to intervene. That list is the input to Phase 2.

**Exit:** two or three features through this loop, and a written list of the
recurring intervention points.

---

## Phase 2 — Automate the fix loop

**Goal:** stop babysitting CI failures.

Turn on `/fix-ci`. Let the fixer iterate against the `ci-failures` artifact
without you reading logs. Keep approving specs and merging by hand.

This is where `summarize-ci.mjs` earns its keep, and where you will find its gaps
— a tool whose output it does not normalise, a message too truncated to act on.
Improve the summariser rather than letting the fixer read raw logs. That is the
whole design.

**Also fold in** whatever Phase 1 revealed. Recurring intervention points belong
in `AGENTS.md` or in a subagent prompt, not in your head. If you corrected the
same thing three times, it is a missing rule.

**Watch for:** the iteration cap. If the fixer regularly hits 5, the problem is
upstream — an unclear spec, or a convention agents cannot infer. Fix the cause.

**Exit:** most PRs reach green without you opening a log.

---

## Phase 3 — Orchestrated feature selection

**Goal:** the loop picks up work on its own.

Now write the orchestrator: a script that reads `specs/features.yaml` and issue
labels, decides which role to invoke, and drives the state machine in
`.agents/README.md`.

Deliberately boring: all state in git and GitHub, none in orchestrator memory.
Kill it mid-feature, restart cold, and it should reconstruct where it was by
reading the repo. Anything it "remembers" is a bug waiting to surface as
inconsistent behaviour you cannot reproduce.

Your two gates remain: approve the spec, merge the PR.

**Watch for:** the temptation to let it merge "obviously fine" PRs. Do not. The
merge gate is what makes every other guard meaningful — an agent that can merge
can eventually merge a change that removes a guard.

**Exit:** you start a run, walk away, and come back to a spec awaiting approval
and a PR awaiting merge.

---

## Phase 4 — Parallel features

**Goal:** several features in flight.

Requires git worktrees per agent, which `AGENTS.md` and the subagents already
specify. The new failure modes are all about collisions:

- Two features adding migrations get sequential numbers and conflict. Serialise
  anything touching `drizzle/`.
- Two features editing `openapi.json` conflict on every regeneration.
- The `dep` graph in `features.yaml` is what prevents genuinely conflicting work
  running concurrently. Keep it honest.

Only worth doing once Phase 3 is boring. Parallelism multiplies the cost of an
unreliable loop.

---

## Where the interesting engineering actually is

The backlog is ordered so the genuinely instructive features come after the loop
works, not before:

| Feature                      | What it teaches                                              |
| ---------------------------- | ------------------------------------------------------------ |
| F-007 Idempotency            | Exactly-once semantics over an at-least-once network         |
| F-009 Session management     | Revocation, and why sessions beat JWTs (ADR 0004)            |
| F-010 Soft delete            | Your first real expand/contract migration across four PRs    |
| F-011 Distributed rate limit | Per-instance state does not survive horizontal scaling       |
| F-012 Caching                | Invalidation, and measuring whether it helped at all         |
| F-013 Search                 | Index design, and watching a k6 threshold catch a regression |
| F-014 Audit log              | Write-heavy tables, retention, PII                           |
| F-015 Account deletion       | Cascades, and deletion that is actually complete             |

**F-010 is the one to be deliberate about.** It is the first change that must
cross four separate PRs and deploys — expand, migrate, switch, contract — and
watching an agent be forced through that sequence by `migration-safety.mjs` is
the clearest demonstration of why the constraint exists.

## A recalibration worth repeating

A todo app on one Postgres and one app server will handle several thousand
concurrent users without effort. You will not hit a scaling wall from the
workload.

The value is in the practices: load thresholds that fail a build, connection
pool arithmetic against `max_connections`, keyset pagination, expand/contract
migrations, health-gated deploys with rollback. F-011 and F-012 add Redis to an
application that does not need it — that is deliberate practice, and worth doing
knowingly rather than under the impression the traffic demands it.
