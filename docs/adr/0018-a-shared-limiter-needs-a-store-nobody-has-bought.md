# 18. The distributed limiter ships without a Redis to talk to

Date: 2026-09-12
Status: Accepted

## Context

F-011 makes the rate limiter distributed. "Distributed" is not a code property —
it is a claim about shared state, and it is true only if a store exists that every
instance can reach. There is no such store. `docs/deployment-sevalla.md` describes
the entire deployed environment, and it contains two managed Postgres databases
(`agentic-todo-db`, `agentic-todo-db-prod`), two applications, and Cloudflare. No
Redis, no Valkey, no memcached, nothing shared beyond Postgres.

Unlike the vendor question in ADR 0012, the platform is not the obstacle and that
was checked rather than assumed: `sevalla databases create --help` lists `redis`
and `valkey` alongside `postgresql`, so this is a dashboard click. The obstacle is
what the click commits us to. This project's own convention, chosen explicitly when
the Postgres instances were created, is a separate datastore per environment. So
the real shape of the request is **two new always-on billed services**, a plan size,
a region, two connection strings placed into two application environments, and a
second stateful thing to upgrade and watch. None of that is improved by an agent
deciding it inside a pull request about where a counter lives.

There is one relevant difference from ADR 0012, and it cuts the other way. Tracing
with no endpoint produces nothing at all. Rate limiting with no Redis produces the
limiter this application has today: `@fastify/rate-limit` with its in-memory
`LocalStore`, enforcing `RATE_LIMIT_MAX` and `AUTH_RATE_LIMIT_MAX` per instance. The
control does not disappear when the variable is empty. It is merely no better than
it was yesterday.

That difference is what decides the ADR 0007 question. ADR 0007 says a security
control's configuration is validated at boot and the process refuses to start when
a control that should be active is not configured. It was written for
`ALLOWED_ORIGINS`, where an empty value **removes** the CSRF check silently. An
empty `REDIS_URL` removes nothing.

## Decision

**F-011 ships the Redis-backed store as a capability selected by `REDIS_URL`, and
that variable is empty in every deployed environment.** When it is empty, no client
is constructed and no `store` option is passed to `@fastify/rate-limit`, so the
executed code path is byte-for-byte the one running in production today.

- **No boot rule requires `REDIS_URL` in production**, and that is a deliberate,
  narrow departure from ADR 0007, justified by the paragraph above: absence leaves
  the control at today's strength rather than removing it. ADR 0007's other
  obligation is honoured in full — the state is knowable, not silent. A boot log
  line reports `{ rateLimitStore: 'redis' | 'memory' }`, and
  `rate_limit_store_operations_total` says which store answered, per request, in
  production.
- Boot rules that **do** apply are the ones about a variable that is set and wrong:
  an unparseable URL, or a scheme that is not `redis:`/`rediss:`, refuses the boot in
  every `NODE_ENV`. A typo must not degrade quietly to local.
- Verification is real and local rather than hypothetical: the integration suite
  starts a throwaway Redis with `testcontainers` and asserts that two separately
  built application instances sharing it enforce **one** combined limit, then stops
  the container mid-test and asserts the degraded behaviour of ADR 0019. The
  distribution is proven; only the instance is missing.
- **Provisioning and enabling is F-022**, deps `[F-011]`, tags `[infra, security]`.
  It owns redis versus valkey, the plan and the bill, one instance per environment
  or one shared, `maxmemory-policy`, the connection strings, and the first hour of
  watching the counter after the switch.

## Consequences

**This feature has no effect in production on the day it merges.** That is the
fourth time this project has shipped something dark — ADR 0010's mail transport,
ADR 0011's advisory verification, ADR 0012's traces are the others — and the pattern
now deserves active suspicion rather than a shrug. Two things distinguish this one.
The dark state here is not a gap, it is the status quo: the limiter that was
protecting `/api/auth/login` yesterday is protecting it identically tomorrow. And
the work that is left for a human is a purchase, not an engineering decision, which
is the only kind of remainder this split is meant to produce.

**If F-022 is never done, F-011 bought nothing in production.** A real risk, and the
reason this ADR is explicit rather than a sentence in a spec. What survives even
then is that the multiplier is now written down with a number attached, and that
turning it on is one environment variable rather than a feature.

**Enabling it later is a behaviour change for real users, and nobody will have
rehearsed it.** Buckets that were per-instance become shared, so a NAT'd office
that quietly received `max × instances` starts receiving `max`. The first
enablement will therefore look like a spike in 429s for legitimate traffic, and the
correct response is usually to raise the limit rather than to roll back. F-022
inherits that obligation, the same way F-019 inherited watching
`trace_spans_exported_total`.

**A trap is documented rather than left to be found.** The `agentic-todo-staging`
application carries `RATE_LIMIT_MAX=100000` and `AUTH_RATE_LIMIT_MAX=100000` as
Sevalla environment variables, added so the Playwright suite could run against live
staging. Anyone provisioning Redis and then verifying distributed limiting there
will observe absolutely nothing until those are reconciled. That reconciliation is
F-022's first task, not a footnote.

**F-012 inherits the same emptiness.** A read-through cache pointed at no Redis is
as dark as this limiter is. Its dependency list is deliberately left alone here —
whether it should also depend on F-022 is a human's call, flagged in the spec and in
the issue rather than decided in a pull request about rate limiting.
