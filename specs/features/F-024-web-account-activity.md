# F-024 · Web UI — account activity screen

> Status is tracked in `specs/features.yaml`, not here.

## Problem

F-014 records what happens to an account — sign-ins, failed sign-ins, password
resets, session revocations — but no browser can show any of it. The only way to
reach `GET /api/auth/audit-events` is to speak HTTP directly, so the question
F-014 exists to answer ("when did this happen, and what else did they do?") is,
from a user's point of view, still unanswerable. A user who revokes a session they
do not recognise on F-020's screen still has no way to see whether that session
ever signed in.

## Scope

**In scope**

- A screen listing the signed-in user's own audit events, newest first, backed by
  `GET /api/auth/audit-events`
- Paging through older events with the same keyset cursor the todo list already
  uses
- Human-readable labels for each `action` and `outcome`, with a defensible
  fallback for values the screen has never seen
- An empty state for an account with no recorded events
- The browser end-to-end journey F-014 could not have: sign in → open activity →
  see the sign-in listed

**Out of scope**

- Any change to `GET /api/auth/audit-events`, its parameters, or its response
- Any new recorded event. F-014's action set is closed (ADR 0025); this feature
  displays it and does not extend it
- Filtering or searching the trail, exporting it, or deleting entries
- Showing anything about another account
- Merging this screen with F-020's session list. They read different endpoints and
  answer different questions; deciding whether they share a settings page is this
  feature's call, but the data must not be interleaved into one list

## Design

<!-- PLANNER: fill this in after F-014 has been reviewed, so this inherits
     whatever the human changed. Points that need an explicit decision:

     - `action` and `outcome` are OPAQUE STRINGS, not a closed enum on the wire
       (F-014's "API changes" explains why: a newer server can send a value an
       older client has never heard of, and a declared enum would be a
       rolling-deploy 500). The screen needs a lookup table with a fallback that
       renders the raw string safely rather than blanking the row or throwing.
     - THE ABSENCE OF AN EVENT IS NOT PROOF THAT NOTHING HAPPENED (ADR 0024): an
       audit write is best-effort and the trail can have holes. The copy must not
       say "this is everything that has happened to your account".
     - The trail starts when F-014 shipped, not when the account was created.
       Every pre-existing account opens this screen to an empty list, which is the
       common case on day one and must not read as an error.
     - A failed sign-in row is the one entry that will alarm a user. Decide what
       it says and what it tells them to do — F-009's revoke-everything-else and
       the password reset flow both already exist and are the actionable answers.
     - Every value rendered here is server-controlled text, but F-006's rule is
       unconditional: textContent, never innerHTML.
     - Timestamps are the whole point of this screen. Decide absolute vs relative
       and state the timezone handling; "3 hours ago" with no absolute value is
       useless in an incident. -->

### API changes

| Method | Path | Auth | Notes |
| ------ | ---- | ---- | ----- |

### Data model changes

<!-- None expected: F-014 owns the table and this feature only reads it. Say so
     explicitly rather than leaving the section blank. -->

### Key decisions

<!-- Alternatives considered and why they were rejected. If a decision is
     architectural, add an ADR under docs/adr/ and link it here. -->

## Acceptance criteria

<!-- PLANNER: at minimum these, plus whatever the design implies. -->

- [ ] After signing in, the activity screen lists that sign-in
- [ ] A failed sign-in against the account appears, labelled as a failure
- [ ] Older events load through the cursor, with no duplicates and no gaps
- [ ] An account with no events shows an empty state, not an error
- [ ] An `action` the screen does not recognise renders as a row rather than
      breaking the list
- [ ] A second account never sees the first account's events
- [ ] Signed out, the screen does not render anyone's events

## Test plan

| Layer       | Cases                                                           |
| ----------- | --------------------------------------------------------------- |
| unit        |                                                                 |
| integration |                                                                 |
| e2e         | sign in → open activity → see the sign-in · empty account state |
| load        |                                                                 |

## Security considerations

<!-- PLANNER: fill in. An attacker holding a stolen session can read this screen;
     F-014 accepts that and explains why. The screen's own risks are rendering
     (textContent, never innerHTML) and persistence — nothing from this endpoint
     goes into localStorage or sessionStorage (F-006's rule). -->

## Observability

<!-- PLANNER: fill in. F-014's counters are server-side; this feature's own signal
     is http_request_duration_seconds{route="/api/auth/audit-events"} finally
     moving at all, which until this ships sits at zero. -->

## Rollout

<!-- PLANNER: fill in. Reversible? What does rollback look like if this ships
     broken at 2am? -->
