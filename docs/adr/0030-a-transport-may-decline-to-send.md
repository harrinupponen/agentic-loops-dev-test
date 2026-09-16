# 30. A transport may decline to send, and says so in the metric

Date: 2026-09-16
Status: Accepted

## Context

Turning on a delivering transport turns on two flows at once, and each of them has
a reason not to reach the provider yet.

**The e2e suite registers accounts.** `e2e/helpers.ts` mints
`web-<timestamp>-<random>@example.com` and 23 call sites across the Playwright
specs create accounts with it. `deploy.yml` runs that suite against
`STAGING_URL` on every merge, with `retries: 2` and several deploys an hour. Every
registration dispatches an `email_verification` message. Against a live provider
that is a stream of hard bounces to addresses that cannot exist, aimed at a domain
IANA reserved so that they cannot (RFC 2606). Providers suspend accounts for
that, and the suspension would land on password reset — the flow this whole
feature exists to make work.

**Email verification has nothing to click.** `POST /api/auth/verify-email/confirm`
takes the token in a request body. There is no browser surface that reads a token
and posts it: ADR 0028 built the fragment mechanism for `#reset=` only and says in
as many words that `#verify=` is not built. A verification mail sent today would
carry a link that loads the todo application and does nothing, leaving the account
unverified and the user with no way to tell why.

The second point is F-017's own argument, turned around. F-017 refused to ship a
"Forgot your password?" link while `MAIL_TRANSPORT=drop` because a path that lies
is worse than no path. A verification mail with an inert link is the same lie in
the other direction.

## Decision

**A delivering transport may decline to send, and every declined message is
counted.** `mail_messages_total` gains one `outcome` value, `suppressed`, next to
`sent` and `failed`. Two rules produce it:

1. **A recipient in a reserved domain is never sent to.** The check is on the
   domain of the address: `example.com`, `example.net`, `example.org`, and any
   address whose domain is or ends in `.test`, `.example`, `.invalid` or
   `.localhost`. These cannot be real mailboxes — that is what the RFC reserves
   them for — so refusing them removes no user's mail and removes the whole
   bounce stream the e2e suite would otherwise generate.
2. **The `email_verification` kind is withheld until a screen exists for it.**
   `sendEmailVerification` returns without calling the provider. `sendPasswordReset`
   delivers.

**The reason lives in the log line, not in a label.** `outcome="suppressed"` keeps
the counter at three values per kind; the structured line carries
`reason: "reserved_domain" | "no_confirmation_page"` where cardinality is free.

**Both rules are code, not configuration.** There is no `MAIL_SUPPRESS_DOMAINS`
and no per-kind enable flag. A flag would let an operator turn the bounce
protection off at 2am without review, and the second rule is meant to be deleted
by the feature that builds the screen, not switched by an environment variable.

**Neither rule is silent.** The boot log line for the transport states them, the
counter shows them, and the metric is the same one ADR 0010 already argues is
page-worthy.

## Consequences

**Staging can run the real transport.** That matters more than it sounds: staging
is the deploy gate, so a transport that only exists in production is a transport
whose first real exercise is production. With rule 1 the Playwright suite proves
nothing about mail and costs nothing in quota or reputation, while an operator can
still register a real address on staging and receive a real reset link.

**F-005 stays inert in production after this ships**, which is not what
`specs/features.yaml` assumed when it wrote F-018's entry. The verification column
keeps not filling, exactly as it does today, and `mail_messages_total` now says
`suppressed` instead of `transport="drop"`. Nothing regresses — nothing is gated
on verification (ADR 0011) — but the backlog entry that ends it is real work and
is named: the email-verification screen, F-026. Deleting rule 2 without building
that screen produces a link that goes nowhere; the rule is the enforcement of
that ordering.

**A user who types `someone@example.com` into the registration form receives
nothing at all, silently.** That is already true of every address that bounces and
it cannot be otherwise: the address is not a mailbox. Registration still returns
`201` and still writes the token row, because the response contract must not
depend on the recipient's domain.

**`suppressed` must not be read as healthy.** On staging it is the normal state
and will dominate. In production a rising `suppressed` on `password_reset` means
real users are typing reserved domains, which is worth knowing and is not worth
paging for. The alert stays on `failed`.

Rejected:

- **Keeping staging on `drop`.** The simplest option, and it makes the deploy
  gate stop exercising the code path that carries credentials. The first live send
  would be in production, at 2am, with a domain nobody had verified end to end.
- **A separate staging provider account, or a provider "test mode" key.** Buys the
  same protection by spending a second account and an extra credential in an extra
  environment, and it still bounces — inside a sandbox, where it still counts
  against a reputation. It also does nothing about the verification link.
- **Sending verification mail with an inert link anyway.** It is the literal
  reading of the backlog entry. It sends a real user a real message that cannot do
  what it says, which is the failure F-017 declined to ship.
- **Building the `#verify=` screen here.** The honest fix, and it is a browser
  feature with its own screen, copy, focus handling and e2e journey. It belongs in
  the web half of the backlog next to F-017, not inside the transport.
