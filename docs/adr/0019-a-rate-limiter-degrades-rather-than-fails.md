# 19. A rate limiter degrades to a local count rather than failing open or closed

Date: 2026-09-12
Status: Accepted

## Context

Moving the rate-limit counter into Redis (F-011, ADR 0018) introduces a dependency
that did not exist before: a request now consults a network service before it is
allowed to proceed. Every shared limiter has to answer one question, and answering
it by omission is how limiters cause outages. **What happens to a request when the
store is unreachable?**

The two stock answers are both bad, and the installed library makes this concrete
rather than theoretical.

**Fail closed.** `@fastify/rate-limit@10.3.0` defaults `skipOnError` to `false`
(`index.js:108`). A store error is rethrown and becomes a 500 through the global
error handler. So the obvious wiring — pass `redis: client` and move on — means a
two-second Redis blip returns 500 on _every_ request in the deployment, including
login, including the web client's own asset fetches. A rate limiter that fails
closed is a self-inflicted total outage whose trigger is the availability of a
component that exists only to count. Worse, it hands an attacker a lever: the
cheapest way to take the API down becomes taking Redis down.

**Fail open.** `skipOnError: true` skips the limit entirely when the store errors.
Every request is allowed. This inverts the attack rather than removing it: the
first move in any credential-stuffing run becomes "make Redis unavailable", after
which there is no limiter at all. A security control that an attacker can switch
off by attacking its dependency is not a control.

The third answer is available here because the thing being replaced still exists.
This application had a working per-instance limiter before F-011 and the library
still ships one. Unreachable Redis does not have to mean "no information about how
many requests this client has made" — it means "no information about the requests
that went to _other_ instances".

## Decision

**When the Redis store errors or times out, the request is counted in a
per-instance in-memory window instead, and served on that basis.** Not rejected,
not blindly allowed: limited, at the strength the application had before F-011.

Concretely, in `src/lib/rate-limit-store.ts`:

- Every `incr` tries Redis first, with a hard per-command budget
  (`REDIS_TIMEOUT_MS`, default 50 ms), `enableOfflineQueue: false`, and
  `maxRetriesPerRequest: 1`. A disconnected client rejects immediately rather than
  queueing, which is the circuit breaker, obtained for free from the client library
  rather than hand-rolled.
- On any error or timeout, the same key is counted in a bounded local window with
  the semantics of the library's own `LocalStore`, and that result is returned. The
  request sees a normal decision — 200 or a normal 429 envelope. It never sees a
  5xx, and the error never reaches the global error handler.
- The transition into and out of degraded mode is **edge-triggered**: one `warn`
  when Redis starts failing, one `info` when it recovers. Not one line per request —
  a store outage must not produce the log flood that hides the incident it caused.
- `rate_limit_store_operations_total{store,outcome}` moves on every decision, so
  "are we distributed right now" is a query rather than a guess.
- **Redis is not part of `/readyz`.** It follows directly: if a store outage is
  survivable, an instance experiencing one is still serving correct responses, and
  failing readiness would remove every instance from rotation at once — converting
  a degraded limiter into exactly the outage the fail-closed option was rejected
  for. A non-fatal condition is reported by a metric, not by a health check.

## Consequences

**An attacker who can take Redis down buys `max × instances`, not unlimited.**
That is the honest cost of this decision, and it is worth stating as a number
rather than as a reassurance. It is also precisely the posture this application has
today with no Redis at all, so the degraded mode is never worse than the status
quo — the limiter's floor is yesterday's ceiling. Against that, taking Redis down
requires reaching Sevalla's internal network, at which point the attacker has
better targets than a counter.

**The limits are therefore never exact, by design.** During a degraded window a
client can exceed the configured limit by up to the instance count, and during
recovery the two counts do not merge — Redis's counter resumes from wherever it
was. Nothing in this system needs an exact limit; it needs a bound. Anyone who
later needs exactness (billing quotas, per-plan entitlements) needs a different
mechanism and should not build it on this one.

**This costs a store class instead of five lines of options.** `skipOnError` alone
cannot express "count somewhere else", so F-011 implements
`FastifyRateLimitStore` rather than passing the library's `redis` option. That is
roughly 120 lines and its own unit tests — the price of not accepting either stock
failure mode. It also means this repo owns the behaviour when the library's
defaults change.

**A slow Redis is bounded, not unbounded.** The 50 ms command budget puts a ceiling
on what a sick-but-reachable store can add to p95, and the degraded path that
follows is pure local memory. A store that is slow rather than down is the failure
mode most likely to be missed, which is why the timeout is a first-class
configuration key with a test asserting the request completes inside it.

**The fallback is a memory allocation an attacker influences**, so it is bounded
explicitly: the local map is cleared wholesale beyond 10 000 entries. It fills only
during an outage, and a fallback limiter that ends the process by exhausting its
heap would be a worse outage than the one it was mitigating.

**This ADR generalises.** Any future dependency consulted on the request path —
F-012's cache is next — is expected to answer the same question explicitly, and the
default answer is this one: degrade to the behaviour that existed before the
dependency did, report it, and keep serving.
