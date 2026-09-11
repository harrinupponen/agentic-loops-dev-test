# F-021 · Web UI — undo delete and trash view

> Status is tracked in `specs/features.yaml`, not here.

## Problem

F-010 makes a deleted todo recoverable for 30 days, but no browser can recover
one. F-016's list screen still has a delete button that looks and feels
permanent, and the only way to reach `POST /api/todos/:id/restore` or
`GET /api/todos?deleted=true` is to speak HTTP directly. The misclick that F-010
exists to undo is still, from a user's point of view, final — the row survives
and nobody can see it.

## Scope

**In scope**

- An undo affordance immediately after a delete, using the id the client already
  has and `POST /api/todos/:id/restore`
- A view of deleted todos backed by `GET /api/todos?deleted=true`, paginated by
  the same keyset cursor as the live list
- Restoring from that view, and placing the restored row correctly
- Telling the user, in words, that deletion is reversible for 30 days
- The browser end-to-end journey F-010 could not have: create → delete → undo →
  confirm the todo is back

**Out of scope**

- Any change to the F-010 endpoints, their responses, or the retention window
- A "delete permanently now" control. F-010 ships no such endpoint, deliberately;
  this feature does not invent one
- Bulk restore, bulk purge, or selecting multiple rows
- Showing how long a deleted todo has left before the sweep removes it, unless
  the design decides the copy needs it

## Design

<!-- PLANNER: fill this in after F-010 has been reviewed, so this inherits
     whatever the human changed. Points that need an explicit decision:

     - A restored todo returns at its ORIGINAL created_at, which may be behind a
       cursor the list has already scrolled past (F-010, "Interaction with
       F-003's keyset pagination"). Decide where it goes on screen. ADR 0008
       says place it from the restore response rather than refetching; say what
       happens when its position is off the loaded page.
     - ADR 0006 chose one page with no client-side router. Is the trash a panel,
       a filter toggle on the existing list, or a separate view? Decide it, do
       not drift into it.
     - web/src/todos.ts already swallows a 404 on delete as "already gone". An
       undo whose row was purged or restored in another tab hits the same case.
     - The undo affordance has a lifetime (a toast? until the next action?) while
       the restore window is 30 days. Those are two different promises; do not
       let the UI imply the shorter one is the real one.
     - Titles are user content: textContent, never innerHTML (F-006's rule). -->

### API changes

| Method | Path | Auth | Notes |
| ------ | ---- | ---- | ----- |

### Data model changes

<!-- None expected: F-010 owns the schema. Say so explicitly. -->

### Key decisions

<!-- Alternatives considered and why they were rejected. If a decision is
     architectural, add an ADR under docs/adr/ and link it here. -->

## Acceptance criteria

<!-- PLANNER: at minimum these, plus whatever the design implies. -->

- [ ] Deleting a todo offers an undo, and taking it puts the todo back in the list
- [ ] The deleted view lists only deleted todos and pages through them
- [ ] Restoring from the deleted view removes it from that view
- [ ] An undo for a todo that is already restored or already purged fails quietly
      rather than showing an error
- [ ] The 30-day window is stated somewhere the user sees before they rely on it
- [ ] A second account never sees the first account's deleted todos

## Test plan

| Layer       | Cases                                                                |
| ----------- | -------------------------------------------------------------------- |
| unit        |                                                                      |
| integration |                                                                      |
| e2e         | create → delete → undo → confirm · delete → open the trash → restore |
| load        |                                                                      |

## Security considerations

<!-- PLANNER: fill in. The trash renders titles the user chose to delete — the
     same XSS surface as the live list and the same rule (textContent). Nothing
     about a deleted todo goes into localStorage or sessionStorage (F-006's
     rule); a client that caches the trash is caching content the user believes
     is gone. -->

## Observability

<!-- PLANNER: fill in. F-010's todos_soft_delete_total{action="restored"}
     sitting near zero after this ships is the signal that undo is broken or
     unreachable. -->

## Rollout

<!-- PLANNER: fill in. Reversible? What does rollback look like if this ships
     broken at 2am? -->
