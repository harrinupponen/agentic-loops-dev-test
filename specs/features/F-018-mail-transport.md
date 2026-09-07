# F-018 · Real outbound mail transport

> Status is tracked in `specs/features.yaml`, not here.

## Problem

Nothing this application sends is delivered. `MAIL_TRANSPORT=drop` is what staging
and production run, so F-004 issues password-reset tokens no user receives and
F-005 issues verification tokens no user can confirm. Both features are correct,
tested, and inert: a locked-out user is still locked out, and every account in
production is permanently unverified. The only signal that this is happening is
`mail_messages_total{transport="drop"}` climbing while nothing is ever consumed.

## Scope

**In scope**

- One transport that actually delivers, selected by a new `MAIL_TRANSPORT` value,
  with its own timeout and no change to the `Mailer` interface's contract
- Credentials and configuration for it in both deployed environments, failing
  closed at boot per ADR 0007
- `APP_BASE_URL` and the link format both existing mail kinds need
- The message bodies for `password_reset` and `email_verification`
- The "your password was changed" notification F-004 parked on F-005

**Out of scope**

- Changing either flow's endpoints, tokens, or response contracts
- An outbox table, a queue, or a delivery worker (ADR 0010 states the cost of not
  having one: a message can be lost if the process dies between the response and
  the send)
- Enforcing email verification anywhere — that is a separate product decision and
  carries the boot rule in ADR 0011
- Marketing, digests, or any mail not triggered by an authentication flow

## Design

<!-- PLANNER: fill this in only once F-005 is merged, so it inherits whatever the
     human changed. Points that need an explicit decision:

     - The provider. This is the first runtime dependency on a third party and
       likely the first new npm package in the application's dependency tree;
       AGENTS.md rule 7 means it must be justified in the PR body. SMTP via a
       maintained client and a hosted provider's API are different bets — say
       which and why.
     - Where the credential lives, and what happens at boot when it is absent
       while MAIL_TRANSPORT names a delivering transport. ADR 0007 says the
       process refuses to start; this is the case that ADR was generalised for.
     - APP_BASE_URL and the link format, jointly with F-017. F-004 deliberately
       added neither. The token may appear in a page URL and must never reach the
       server in a query string.
     - Whether `drop` and `console` survive as values, and what the integration
       suite and scripts/dump-openapi.ts default to. They must keep working with
       no network.
     - Timeouts, retries, and what a rejected send does beyond incrementing
       mail_messages_total{outcome="failed"}. The send is not awaited, so nothing
       downstream can react to it.
     - Bounces and complaints. A hard bounce is evidence an address is wrong,
       which is exactly what F-005 records — decide whether that loop is in scope
       or deliberately left out.
     - Rate limits and per-account cooldowns become real spend and real
       reputation. Re-check F-004's PASSWORD_RESET_RATE_LIMIT_MAX and F-005's
       reliance on the 60-second cooldown against a provider's actual limits.
     - The staging environment will now send real mail to real addresses on every
       e2e run against STAGING_URL. Decide what stops that. -->

## Acceptance criteria

<!-- PLANNER: at minimum these, plus whatever the design implies. -->

- [ ] A reset token and a verification token are both delivered to a real mailbox
      in a manually verifiable way, without either flow's code changing
- [ ] The application refuses to boot when a delivering transport is configured
      without a usable credential
- [ ] `drop` remains available and remains what tests and the OpenAPI dump use
- [ ] A send that times out or is rejected increments
      `mail_messages_total{outcome="failed"}` and never changes an HTTP response
- [ ] No message body, log line, or metric label contains a raw token or an
      address

## Test plan

| Layer       | Cases |
| ----------- | ----- |
| unit        |       |
| integration |       |
| e2e         |       |
| load        |       |

## Security considerations

<!-- PLANNER: fill in. A live transport turns two dark features on at once. The
     credential is new, the outbound network egress is new, and the message body
     carries a credential by design. -->

## Observability

<!-- PLANNER: fill in. mail_messages_total stops being decorative the moment it
     can report a real failure; ADR 0010 already argues it is page-worthy. -->

## Rollout

<!-- PLANNER: fill in. This is the deploy where two features stop being inert.
     Decide the order: transport first with nothing pointed at it, or both at
     once, and what the first hour of real sending is watched with. -->
