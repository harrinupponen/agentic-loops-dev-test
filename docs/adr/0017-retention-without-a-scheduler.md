# 17. Retention windows are swept opportunistically, not scheduled

Date: 2026-09-11
Status: Accepted

## Context

F-010 keeps a deleted todo for a retention window and then removes it for real.
That is the second table in this application with a retention window; F-007's
`idempotency_keys` was the first, and F-014's audit log and F-015's export
artefacts will not be the last. The mechanism is worth deciding once.

There is no scheduler anywhere in this repository. No cron container, no timer in
the process, no queue, no worker deployment — the only thing on a schedule is
`.github/workflows/nightly.yml`, which runs tests in CI and has no database
credentials and no business touching production data. Two tables solve retention
without one today: the recovery-token tables are capped at one row per account by
their primary key and need no sweep at all (ADR 0009), and `idempotency_keys` is
swept opportunistically — `src/plugins/idempotency.ts` deletes up to 100 of the
requesting user's expired rows on a keyed request, inside a `try/catch` that logs
and continues.

Adding a scheduler is not a small thing in this deployment. Sevalla runs the
application as a rolling set of replicas, so a timer in the process runs in all
of them at once and needs an advisory lock to be safe; a separate cron workload
needs its own deployment, its own image, its own database credentials, its own
alert when it stops running silently, and its own place in the deploy pipeline.
None of that is hard. All of it is a component nobody is currently paid to watch,
for a table whose garbage arrives one row at a time.

## Decision

Retention is enforced by a bounded, best-effort sweep on the request path that
creates the rows being retained.

The shape, copied from `src/plugins/idempotency.ts` rather than reinvented:

- **Scoped to the caller.** `user_id = $caller` appears in both the outer
  statement and the subselect that picks the batch, so a mistake in one of them
  cannot widen the sweep to another account.
- **Bounded.** One batch, a hard `LIMIT` (100 rows), so a user with a large
  backlog cannot turn one request into a long `DELETE`. What a batch leaves
  behind, the next request picks up.
- **Best-effort.** Wrapped in `try/catch`; a failure logs a warning and the
  request succeeds anyway. Bookkeeping never fails a user's operation.
- **Attached to the operation that creates the garbage** — the delete path for
  F-010, the keyed-request path for F-007 — never to a read. Hot read paths stay
  reads, and users who generate no garbage pay nothing.
- **The window is a constant in the code**, not an environment variable. A
  retention period is a product and privacy decision that belongs in the spec and
  in the ADR, not in a `.env` file where it can differ between environments
  without anyone noticing.

## Consequences

Retention means **at least** the window, not **at most**. A user who deletes one
todo and never returns keeps that row indefinitely, because nothing sweeps
without a request from them. This is the honest cost, and it is acceptable
precisely while the application makes no external promise of the form "deleted
data is erased within 30 days". If such a promise is ever made — in a privacy
policy, a contract, or a compliance regime — this ADR is what has to change
first, and the change is a real scheduled job with locking, alerting, and an
owner. Superseding this ADR is the intended path for that, not quietly bolting a
timer onto a route.

Cleanup scales with the traffic that produces the mess: every delete purges up to
100 expired rows for that account, so an active deleter's backlog shrinks faster
than they can grow it, and an inactive one's backlog is small by definition. The
pathological case — many accounts that each deleted a lot once and then went
quiet — leaves rows behind indefinitely and is visible as `deleted` climbing
while `purged` stays near zero on the counters F-010 defines.

There is one operational tell worth writing down, because its absence is silent:
if the purge counter is flat at zero for longer than the window, retention is not
happening. Nothing else in the system will say so.

The upside is what is not there. No extra workload to deploy, no advisory lock,
no leader election, no cron container drifting out of sync with the image it is
supposed to match, and no midnight page for a job nobody remembers owning.
