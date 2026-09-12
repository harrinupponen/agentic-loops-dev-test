# F-022 · Provision shared Redis and enable the distributed limiter

> Status is tracked in `specs/features.yaml`, not here.

## Problem

Nothing in this deployment shares state across instances. F-011 built a rate
limiter that counts in Redis and falls back to a per-instance window when it cannot
reach one (ADR 0018, ADR 0019), but `REDIS_URL` is empty in staging and production,
so every instance still enforces `RATE_LIMIT_MAX` and `AUTH_RATE_LIMIT_MAX` against
its own memory. An attacker spreading a credential-stuffing run across the
deployment still gets the configured limit multiplied by the instance count, and
every rolling deploy still resets every counter. The code that fixes this is
merged, tested against a real Redis in CI, and running nowhere, because turning it
on requires buying something and nobody has decided what.

## Scope

**In scope**

- A decision, with an ADR, on the shared datastore: redis or valkey, plan size,
  region, and whether staging and production get their own instances or share one
  — the project's existing convention is one datastore per environment
- Provisioning it on Sevalla and placing `REDIS_URL` into each application's
  environment as a credential, with the same handling `DATABASE_URL` gets
- `maxmemory-policy`, and an explicit statement that the keyspace is disposable —
  no backups, no persistence requirement
- Reconciling `agentic-todo-staging`'s `RATE_LIMIT_MAX=100000` and
  `AUTH_RATE_LIMIT_MAX=100000` overrides, which currently make any verification of
  distributed limiting on staging meaningless
- Enabling staging first, then production, and watching
  `rate_limit_store_operations_total{store="local"}` and the 429 rate for the first
  hour after each
- `docs/deployment-sevalla.md`: the new instance, the variable, the connection
  path, and what a degraded limiter looks like in the logs

**Out of scope**

- Any change to `src/lib/rate-limit-store.ts`, `src/lib/redis.ts`, or the limits
  themselves. If the feature needs a code change to be enabled, that is a bug in
  F-011, not work for this feature.
- The read-through cache (F-012), even though it will want the same instance.
- Redis for sessions, idempotency keys, or anything durable. Postgres remains the
  only store of record.
- Cluster, Sentinel, or cross-region replication.

## Design

<!-- Filled in by the Planner. The human approves THIS before any code is written. -->

### API changes

| Method | Path | Auth | Notes |
| ------ | ---- | ---- | ----- |

### Data model changes

<!-- New tables/columns/indexes. State the expand/contract plan explicitly:
     which migration is additive, what backfills, what is dropped in a later PR. -->

### Key decisions

<!-- Alternatives considered and why they were rejected. If a decision is
     architectural, add an ADR under docs/adr/ and link it here. -->

## Acceptance criteria

<!-- Each one must be independently testable. The PR ticks these; CI proves them.
     If you cannot describe the test, the criterion is too vague. -->

- [ ]
- [ ]

## Test plan

| Layer       | Cases                                                                     |
| ----------- | ------------------------------------------------------------------------- |
| unit        |                                                                           |
| integration | happy path · validation failure · unauthenticated · other user's resource |
| e2e         |                                                                           |
| load        | thresholds if this touches a hot path                                     |

## Security considerations

<!-- Threat model for this feature specifically. What could an attacker do?
     What data becomes reachable? What is rate limited? What gets logged? -->

## Observability

<!-- What metric, log field, or trace span proves this works in production?
     "It passed CI" is not observability. -->

## Rollout

<!-- Feature flag? Backfill? Reversible? What does rollback look like if this
     ships broken at 2am? -->
