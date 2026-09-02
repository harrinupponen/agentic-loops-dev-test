# F-016 · Web UI — todo list screen

> Status is tracked in `specs/features.yaml`, not here.
>
> Split out of F-006 during planning: "auth screens and todo list" was ~900–1000
> hand-written lines across three test layers, past the ~500-line guidance in
> `.agents/planner.md`. F-006 builds the shell, static serving, and the auth
> screens; this feature fills the signed-in panel with the list. Design is
> deliberately left for a planning run **after F-006 has been reviewed**, so it
> inherits whatever the human changes about the shell.

## Problem

Once F-006 ships, a signed-in user sees their email address and a log-out button.
The todos they own — the entire product — remain reachable only through the JSON
API. Everything needed to show them exists: `GET /api/todos` with keyset
pagination and a completed filter, `POST`, `PATCH`, and `DELETE` from F-003, and
`Idempotency-Key` on create from F-007.

## Scope

**In scope**

- Render the signed-in user's todos, newest first, inside the F-006 shell
- Load more via `nextCursor`, using the existing keyset pagination — never an
  offset, and never "fetch everything"
- Create a todo, sending an `Idempotency-Key` so a double-submit or a retried
  request cannot produce a duplicate (F-007 exists precisely for this client)
- Toggle completion and delete a todo
- Empty state, loading state, per-action error state, all keyboard accessible
- Browser e2e for the create → complete → delete journey

**Out of scope**

- Any API change. Every endpoint this needs already exists.
- The completed filter that `GET /api/todos?completed=` supports. The list shows
  everything; a filter is a separate, stated requirement when someone states it.
- Editing a title in place, reordering, drag and drop, bulk actions, due dates,
  tags, search (F-013), undo/restore (F-010)
- Optimistic updates and local caching. Re-read after a write; the list is short
  and the request is cheap.
- Infinite scroll. An explicit "Load more" button is keyboard- and
  screen-reader-accessible and does not fight the browser's scroll restoration.

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
