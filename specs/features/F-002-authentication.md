# F-002 · User registration and login with session cookies

> Status is tracked in `specs/features.yaml`, not here.

## Problem

<!-- What is broken or missing today, from a user's point of view. One paragraph.
     No solution language. -->

## Scope

**In scope**

-

**Out of scope**

<!-- Be explicit. This is the main defence against an agent gold-plating. -->

-

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
