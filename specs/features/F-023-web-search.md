# F-023 · Web UI — search the todo list

> Status is tracked in `specs/features.yaml`, not here.

## Problem

F-013 lets a user find a todo by the words in its title, but no browser can ask.
F-016's list screen still offers only "scroll until you see it", and the only way
to reach `GET /api/todos?q=` is to speak HTTP directly. The problem F-013 exists
to solve — an old todo is unreachable in a list that only grows — is, from a
user's point of view, still unsolved.

## Scope

**In scope**

- A search input on the list screen, backed by `GET /api/todos?q=`
- Paging through search results with the same keyset cursor the list already uses
- Clearing the search and returning to the unfiltered list
- An empty-result state that reads as "nothing matched", not as an error
- The browser end-to-end journey F-013 could not have: create → search → find →
  clear

**Out of scope**

- Any change to `GET /api/todos`, its parameters, or its response
- Relevance ranking, highlighting matched terms, or a result count. F-013 ships
  none of these, deliberately (ADR 0022); this feature does not invent them
- Search suggestions, history, or storing anything the user typed
- Searching from anywhere but the list screen

## Design

<!-- PLANNER: fill this in after F-013 has been reviewed, so this inherits
     whatever the human changed. Points that need an explicit decision:

     - Results are newest first, NOT best first (ADR 0022). The screen must not
       imply ranking — no "top result", no reordering as the user types.
     - Matching is whole-word after stemming: `gro` does not match `groceries`,
       so search-as-you-type sends requests that legitimately return nothing
       until a whole word is typed. Decide between search-on-submit and
       debounced-as-you-type with that in mind, and say what the empty state says
       in the meantime.
     - A query of only stop words ("the") legitimately returns zero rows. The
       copy has to survive that without claiming the search broke.
     - How search composes on screen with the existing completed filter and with
       F-021's trash view: `q` composes with both in the API. Decide whether the
       UI exposes that or keeps search live-only, and do not drift into it.
     - The query text is user content. It goes in the URL of an API request and
       nowhere else: not into localStorage or sessionStorage (F-006's rule), not
       into a log, not into an analytics event.
     - Titles are user content: textContent, never innerHTML (F-006's rule). -->

### API changes

| Method | Path | Auth | Notes |
| ------ | ---- | ---- | ----- |

### Data model changes

<!-- None expected: F-013 adds no schema at all. Say so explicitly. -->

### Key decisions

<!-- Alternatives considered and why they were rejected. If a decision is
     architectural, add an ADR under docs/adr/ and link it here. -->

## Acceptance criteria

<!-- PLANNER: at minimum these, plus whatever the design implies. -->

- [ ] Typing a word and searching shows only the matching todos
- [ ] Clearing the search restores the full list
- [ ] A search that matches nothing shows an empty state, not an error
- [ ] Search results page through the same cursor as the list, with no duplicates
- [ ] A second account never sees the first account's todos in a search
- [ ] Nothing the user typed is persisted in the browser

## Test plan

| Layer       | Cases                                                   |
| ----------- | ------------------------------------------------------- |
| unit        |                                                         |
| integration |                                                         |
| e2e         | create → search → find → clear · search with no matches |
| load        |                                                         |

## Security considerations

<!-- PLANNER: fill in. The result list renders titles — the same XSS surface and
     the same rule as the live list (textContent). The query is user content and
     must not be persisted client-side or logged. -->

## Observability

<!-- PLANNER: fill in. F-013's todo_search_total sitting near zero after this
     ships is the signal that the search box is broken or unreachable, and its
     duration histogram finally sees real query shapes rather than none. -->

## Rollout

<!-- PLANNER: fill in. Reversible? What does rollback look like if this ships
     broken at 2am? -->
