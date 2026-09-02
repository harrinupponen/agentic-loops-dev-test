# Phase 1 findings

Written per `docs/ROADMAP.md`'s Phase 1 exit criterion, after running two
features (F-007, F-006) through the full planner → implementer → reviewer
loop. This is the input to Phase 2 — read it before turning on `/fix-ci`.

Scoped deliberately: this covers the _feature-development loop_ only. The
same two nights also surfaced a long chain of deploy-pipeline and
third-party-platform bugs (a stale CI action pin, wrong env var names, a
stuck approval blocking the deploy concurrency queue, a Sevalla API-path
outage). None of that is included here — it's infrastructure debt, not
evidence about whether the agent loop itself is trustworthy, and mixing the
two would make this list useless as a Phase 2 input.

## Where a human had to actually intervene

1. **The planner defaults to "first unblocked backlog item," and that
   default is sometimes wrong.** Both rounds needed an explicit,
   roadmap-citing instruction to skip `F-004` in favor of `F-006`/`F-007`.
   This is expected — the roadmap's own Phase 1 section names this exact
   override — but it doesn't self-correct. Whoever runs `/next-feature` has
   to already know why F-004 is a bad first pick.

2. **A flagged risk wasn't specified strictly enough on its own.** F-006's
   first spec draft treated `ALLOWED_ORIGINS` defaulting empty (silently
   disabling CSRF protection) as something to remember to configure
   operationally. Given how many "someone forgot to set this correctly"
   bugs the deploy pipeline had already produced, that was judged
   insufficient. One amendment round converted it into a hard boot-time
   refusal instead of a documentation note.

3. **That amendment had blast radius the original design didn't scope.**
   Once the requirement became "refuse to boot without this set," three CI
   workflow jobs that build-then-boot the app suddenly needed the same env
   var too. Not caught until the second pass. Worth remembering generally:
   turning a soft security recommendation into a hard requirement tends to
   ripple into CI config more than the first draft accounts for.

4. **A tooling non-idempotency, not a judgment failure.** Prettier
   flip-flopped between three different indentations across repeated
   `--write` runs on a markdown line where an inline code span was split
   across the wrap point. Diagnosed and fixed by hand rather than sent back
   to an agent — genuinely a formatter bug interacting with the content,
   not something a planner or implementer got wrong.

## Where the loop caught its own problems — no human needed

5. Implementer scope-creep (an out-of-scope backlog entry added inside
   F-007's PR, duplicating an already-tracked issue) was caught by the
   reviewer's fresh-context pass, not by the human. Exactly the isolation
   the role separation is designed to produce.

6. A real reliability bug (F-007's retention-sweep query: unbounded, and
   unprotected against its own failure) was caught, fixed, and
   re-verified across two review rounds without the human spotting it
   first.

7. Both reviewer passes were rigorous without being prompted to be —
   mutation-testing the security-critical checks, booting the real
   production build rather than trusting `app.inject`, probing path-
   traversal payloads beyond what the written test suite covered. Zero
   corrections needed from the human on either verdict.

## A calibration point, not really an intervention

8. Line-budget estimates ran short both times: F-007 landed at ~730 lines
   against a ~500-line guess, F-006 at ~1226 against a ~515-line estimate.
   Both times the implementer flagged the overrun and explained it before
   being asked, and the reasoning held up under review. Treat future
   estimates as roughly 1.5–2.5x low rather than tightening the guidance
   itself.

## One pure config gap — not agent behavior

9. The E2E workflow doesn't trigger on a PR opened non-draft in one shot
   (its `pull_request` trigger only fires on `ready_for_review`, `labeled`,
   `synchronize` — not `opened`). Pre-existing repo config, not caused by
   any agent in this loop. But it means real E2E coverage on an
   implementer's first push requires a human (or a future orchestrator) to
   know to add the `run-e2e` label — otherwise it silently goes
   unexercised, which is exactly what happened on F-006's PR until it was
   caught and fixed before merge.

## Net read

Nothing here suggests the planner/implementer/reviewer loop itself is
untrustworthy on this codebase — the interventions that were needed were
mostly about sharpening what "done" means in a spec (item 2), not about the
agents failing to follow a clear spec. The reviewer in particular needed no
correction across two rounds. Phase 2's `/fix-ci` is a reasonable next step;
the CI-trigger gap (item 9) is worth fixing or documenting explicitly before
an orchestrator runs unsupervised in Phase 3.
