# F-020 · Web UI — session management screen

> Status is tracked in `specs/features.yaml`, not here.

## Problem

F-009 builds the session list and revoke API, but no browser can reach it. A user
who wants to check where they are still signed in, or end a session on a device
they no longer have, still has no way to do either — F-006 put "log out
everywhere (F-009)" out of scope and pointed at F-009, and F-009 builds the API
only. The question F-009 set out to answer, "am I still signed in somewhere I
should not be?", is not actually answerable by a human being until this ships.

## Scope

**In scope**

- A signed-in view listing the account's sessions from `GET /api/auth/sessions`,
  marking the current one
- Revoking one session with `DELETE /api/auth/sessions/:id`
- "Sign out everywhere else" with `DELETE /api/auth/sessions`
- Handling the case where the user revokes the session they are using: the
  response clears the cookie, so the page returns to the sign-in form
- Surfacing `404` (already gone — drop the row), `401`, and `429`
- The browser end-to-end journey F-009 could not have: sign in twice, see two
  sessions, revoke one, confirm it is gone

**Out of scope**

- Any change to the F-009 endpoints or their responses
- Parsing or prettifying the user agent string (F-009 stores it raw on purpose;
  see ADR 0015)
- Naming or renaming sessions, session history, or login notifications

## Design

<!-- PLANNER: fill this in after F-009 has been reviewed, so this inherits
     whatever the human changed. Points that need an explicit decision:

     - The user agent is attacker-controlled text. It must be rendered with
       textContent and never innerHTML — F-006's rule, which the CSP also backs.
       This is the single hard constraint F-009 hands to this feature.
     - ADR 0006 chose one page with no client-side router. Where does this view
       live: a panel on the existing page, or something that pushes against that
       decision? Decide it, do not drift into it.
     - ADR 0008: the list is what the server returned. A revoke returns 204, so
       the affected rows are removed from the rendered array without a refetch.
     - `truncated: true` in the response means the account has more than 100
       sessions. Say what the user is told, rather than silently showing 100.
     - Revoking the current session clears the cookie in the same response. The
       page has to notice and return to the signed-out state without a reload. -->

### API changes

| Method | Path | Auth | Notes |
| ------ | ---- | ---- | ----- |

### Data model changes

<!-- None expected: F-009 owns the schema. Say so explicitly. -->

### Key decisions

<!-- Alternatives considered and why they were rejected. If a decision is
     architectural, add an ADR under docs/adr/ and link it here. -->

## Acceptance criteria

<!-- PLANNER: at minimum these, plus whatever the design implies. -->

- [ ] A signed-in user sees their sessions, with the current one marked
- [ ] Revoking another session removes it from the list with no refetch
- [ ] Revoking the current session returns the page to the sign-in form
- [ ] "Sign out everywhere else" leaves exactly one session
- [ ] A user agent containing HTML is rendered as text, and no CSP violation or
      console error occurs anywhere in the journey
- [ ] A second account never sees the first account's sessions

## Test plan

| Layer       | Cases                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------- |
| unit        |                                                                                                |
| integration |                                                                                                |
| e2e         | sign in twice → list → revoke one → reload · revoke the current one · sign out everywhere else |
| load        |                                                                                                |

## Security considerations

<!-- PLANNER: fill in. The user agent is the whole story: it is the first
     attacker-controlled string this client renders. Also: nothing about a
     session goes into localStorage, sessionStorage, or a readable cookie
     (F-006's rule), including the public id. -->

## Observability

<!-- PLANNER: fill in. F-009's sessions_revoked_total sitting at zero after this
     ships is the signal that the screen is broken or unreachable. -->

## Rollout

<!-- PLANNER: fill in. Reversible? What does rollback look like if this ships
     broken at 2am? -->
