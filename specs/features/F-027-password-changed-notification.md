# F-027 · "Your password was changed" notification mail

> Status is tracked in `specs/features.yaml`, not here.

## Problem

A password reset changes a credential and revokes every session, and the account's
owner is told nothing. If the reset was not theirs — a mailbox compromised, a
token intercepted — the first signal they get is that their password no longer
works, with nothing to say when it changed or what to do. F-004 parked this
notification on F-005, F-005 parked it on F-018, and F-018 declined it on diff
budget and on the grounds that it is not the transport. It has now waited three
features and is the last piece of F-004's design that has never shipped.

A delivering transport exists (F-018), so for the first time the notification can
actually arrive.

## Scope

**In scope**

- A third `Mailer` method and its plain-text message, dispatched when
  `POST /api/auth/password-reset/confirm` succeeds
- `mail_messages_total{kind="password_changed"}` and the failure handling that
  goes with an un-awaited send (ADR 0010 — unchanged: fail-open, counted, never a
  `5xx`)
- The copy, including what a recipient who did not do this is told to do, given
  that this application has no support address and no "revoke everything" link a
  signed-out user can use

**Out of scope**

- Any change to the reset flow's responses, tokens, or session invalidation.
- A notification for a future authenticated password change; there is no such
  endpoint today.
- Login-from-new-device notifications, which are a different feature and would
  need F-009's session metadata.
- An in-app notification centre.

## Design

<!-- Filled in by the Planner. The human approves THIS before any code is written.
     Points that need an explicit decision:

     - This touches `src/routes/auth.ts`, which is CODEOWNERS-protected. Say so
       and keep the change to the smallest possible dispatch.
     - The mail goes to an address that just proved mailbox control, so the
       enumeration argument does not apply — but the send must still be
       un-awaited, or reset-confirm latency starts tracking the provider.
     - What the message offers a victim. "Contact support" is a lie without a
       support address; a second reset link is a credential nobody asked for.
     - Whether ADR 0030's reserved-domain suppression covers this kind too (it
       should, for free, if the check stays in the transport). -->

### API changes

| Method | Path | Auth | Notes |
| ------ | ---- | ---- | ----- |

### Data model changes

<!-- Expected: none. -->

### Key decisions

<!-- Alternatives considered and why they were rejected. -->

## Acceptance criteria

- [ ]
- [ ]

## Test plan

| Layer       | Cases |
| ----------- | ----- |
| unit        |       |
| integration |       |
| e2e         |       |
| load        |       |

## Security considerations

<!-- The message says a credential changed. It must not contain a token, a
     session, or anything that lets its holder act on the account. -->

## Observability

<!-- A new `kind` on an existing counter. A failed notification is invisible to
     the user by construction. -->

## Rollout

<!-- Needs a delivering transport to mean anything; inert under drop. -->
