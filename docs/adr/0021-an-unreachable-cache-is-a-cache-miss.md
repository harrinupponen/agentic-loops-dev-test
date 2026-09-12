# 21. An unreachable cache is a cache miss, and there is no local fallback

Date: 2026-09-12
Status: Accepted

## Context

ADR 0019 ended with an obligation: "any future dependency consulted on the request
path — F-012's cache is next — is expected to answer the same question explicitly,
and the default answer is this one: degrade to the behaviour that existed before the
dependency did, report it, and keep serving." This ADR answers it, and reaches the
same shape by a different route, because a cache and a limiter fail differently.

The limiter had a genuine third option. Its job is to count, and counting in process
memory is _weaker_ than counting in Redis but still correct, so "degrade to a
per-instance window" was a real floor. A cache's job is to return the same bytes
Postgres would have returned. There is no weaker-but-correct version of that. An
answer is either the current state of the user's todos or it is wrong.

Two failure modes have to be separated, because only one of them is dangerous.

**Redis cannot answer a read or a write-back.** Nothing is lost. The behaviour that
existed before the dependency did is "query Postgres", which is not a degradation —
it is the correct answer, computed the slow way.

**Redis cannot answer an invalidation.** This one is dangerous, and it is the only
path in the feature that can show a user their own stale data. The row is already
committed in Postgres and the response has to be sent; the cached page for that user
survives until its TTL.

A third option was available for the read path and is worth recording because it looks
attractive: a per-instance in-memory cache used when Redis is absent or unreachable,
by direct analogy with ADR 0019's local window. It would also make this feature do
something on the day it merges, which no feature since F-007 has.

## Decision

**A Redis error, a timeout, or an absent Redis is treated as a cache miss on the read
path, and as a best-effort no-op on the write-back path. There is no local fallback
cache. A failed invalidation never fails the user's write; it is counted, logged once
per transition, and bounded by the TTL.**

- Every cache command is wrapped to the existing `REDIS_TIMEOUT_MS` budget (50 ms) on
  top of the client's own `commandTimeout`, so a sick-but-reachable Redis adds a bounded
  amount to a request rather than becoming the latency it was supposed to remove.
- A cache error is never surfaced to the client — no 5xx, never a stale serve, never a
  changed status code. The request produces exactly the response it would have produced
  with `TODO_LIST_CACHE_ENABLED=false`.
- `todo_list_cache_operations_total{operation,outcome}` moves on every read, write-back,
  and invalidation, and the degrade/recover transition logs one `warn` and one `info` —
  edge-triggered, for the reason ADR 0019 gives: a store outage must not produce the log
  flood that hides the incident it caused.
- **Redis stays out of `/readyz`**, unchanged from ADR 0019 and for a stronger reason:
  an instance whose cache is down is serving byte-identical correct responses.
- **The cached entry is re-validated against the route's own zod response schema before
  it is served**, and a field that does not parse is treated as a miss. The stored shape
  carries a `v1` prefix as well, so a deploy that changes `TodoView` cannot serve a
  previous release's shape out of a cache that outlived it.

**The per-instance fallback cache is rejected.** Its invalidation would be per-instance
too: a user with two tabs behind a load balancer deletes a todo on instance A, which
clears only instance A's copy, and their next list — served by instance B — contains
the todo they just deleted, for a full TTL, with no write of their own available to
clear it. For the rate limiter, per-instance state was weaker but never wrong. For a
cache, per-instance state is **wrong**, and it is wrong in precisely the way that makes
a todo application feel broken. The fact that it would have made merge day less dark is
not a reason to ship a known correctness bug.

## Consequences

**The cache cannot cause an outage, only a missed optimisation.** That asymmetry is the
whole reason this decision is cheaper to make than ADR 0019's was. An attacker who takes
Redis down removes a latency improvement; there is no security control behind it, no
`skipOnError` trap in a third-party plugin to work around, and no fail-closed default to
disarm.

**A failed invalidation is the one user-visible failure mode, and it is bounded by the
TTL, not eliminated.** A 30-second worst case in which a user sees a todo they deleted.
This is the honest cost of the feature and it is the reason the TTL is short and the
reason `TODO_LIST_CACHE_ENABLED` exists as its own switch: the mitigation for a cache
behaving badly at 2am must not be "unset `REDIS_URL`", because that would also switch
off F-011's distributed rate limiting to fix a stale list.

**Retrying a failed invalidation is deliberately not attempted.** A retry queue, an
outbox table, or a second attempt on the next request all convert a 30-second bounded
staleness into durable state with its own failure modes, for a window that a short TTL
already closes. If the counter shows invalidation errors happening routinely rather
than during an outage, the answer is to fix Redis, not to build a compensation
mechanism around it.

**`GET /api/todos` gains a second reason to be slow.** On a miss, the request pays a
Redis round trip _and_ the Postgres query. With the 50 ms budget that is a bounded
regression on the miss path, paid for by the hit path; if the hit ratio is low the
feature is a net loss and the metric will say so plainly.

**Nothing in the feature is load-bearing.** Removing the cache entirely at any future
date is deleting a module and four call sites. No migration, no stored format anyone
depends on, no client behaviour built on top of it.
