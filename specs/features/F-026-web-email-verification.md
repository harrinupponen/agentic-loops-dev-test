# F-026 · Web UI — email verification screen

> Status is tracked in `specs/features.yaml`, not here.

## Problem

F-005 issues a verification token and `POST /api/auth/verify-email/confirm`
consumes one, but the token travels in a **request body** and nothing in the
browser can post it. There is no screen, no link a mail client can render, and
therefore no way for any user to verify an address. F-018 shipped a delivering
transport and had to withhold the verification kind entirely for exactly this
reason (ADR 0030, rule 2): a verification mail today would carry a link that loads
the application and does nothing, leaving the account unverified with no
explanation — the same lie F-017 refused to ship for password reset.

Until this lands, `users.email_verified_at` stays NULL for every account, in
production, forever.

## Scope

**In scope**

- A verification panel on the existing single page, reached by
  `<APP_BASE_URL>/#verify=<token>`, following ADR 0028's fragment mechanism:
  parse, scrub with `history.replaceState`, hold in memory, POST to confirm
- Success, `invalid_token` and `token_expired` states, and a resend affordance for
  a signed-in user (`POST /api/auth/verify-email`, which already exists and is
  authenticated)
- The message body and subject for the `email_verification` kind in the mail
  transport, composed as `<APP_BASE_URL>/#verify=<token>`
- **Deleting rule 2 of ADR 0030** so verification mail actually leaves, and
  superseding that part of the ADR
- The browser journey, within the constraints F-017 documented — the raw token
  lives only inside the `Mailer`, so the happy path cannot be an e2e

**Out of scope**

- Enforcing verification anywhere. Nothing is gated on it and making something
  gated is a product decision carrying ADR 0011's boot rule.
- Backfilling or inventing a verified state for existing accounts (F-005 rejected
  this by name).
- Changing `POST /api/auth/verify-email/confirm`, its token, or its responses.
- Bounce handling, which is still nobody's feature.

## Design

<!-- Filled in by the Planner. The human approves THIS before any code is written.
     Points that need an explicit decision:

     - Whether the fragment parsing generalises F-017's `#reset=` code or
       duplicates one line of it. ADR 0028 says the abstraction waits for a second
       caller; this IS the second caller, so decide deliberately.
     - What a signed-out visitor sees when they open a verification link, given
       the token verifies the account it was issued for and NOT the caller's.
     - Whether ADR 0030's rule 2 is deleted or narrowed, and what the metric shows
       the day it changes. -->

### API changes

| Method | Path | Auth | Notes |
| ------ | ---- | ---- | ----- |

### Data model changes

<!-- Expected: none. F-005 already ships the column. -->

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

<!-- A mailbox token proves control of a mailbox, not of a password: it must not
     mint a session. The fragment must be scrubbed before render (ADR 0028). -->

## Observability

<!-- email_verification_total{outcome="consumed"} stops being structurally zero
     the day this ships. That is the arrival signal. -->

## Rollout

<!-- Two switches move together: the screen, and the transport's withheld kind. -->
