# 29. Mail leaves over the provider's HTTPS API, not SMTP

Date: 2026-09-16
Status: Accepted

## Context

F-004 and F-005 both issue a token and hand it to the `Mailer` seam ADR 0010
built. Every deployed environment runs `MAIL_TRANSPORT=drop`, so nothing is
delivered: a locked-out user stays locked out and every production account is
permanently unverified. F-018 has to put something real behind that seam, and the
choice of _how_ mail leaves the process is the one architectural decision in the
feature.

Four constraints shape it:

- **AGENTS.md rule 7.** Every `package-lock.json` change triggers human review and
  has to be justified. This would be the first runtime dependency on a third party
  and the first new package since the OpenTelemetry set.
- **Node 22 has `fetch` and `AbortSignal.timeout` in core.** An HTTPS call to a
  provider's API needs no library at all; SMTP needs one, because nothing in core
  speaks it.
- **Egress from Sevalla is Kubernetes on GCP behind Cloudflare.** HTTPS out is
  certain to work. Outbound port 587/465 to a third party is not something
  `docs/deployment-sevalla.md` records anyone having tested, and discovering it is
  blocked is discovering it in production.
- **ADR 0010 requires each transport to apply its own timeout** and dispatches the
  send without awaiting it, so whatever is chosen must be cancellable and must
  never hang.

## Decision

**One transport, `MAIL_TRANSPORT=resend`, that POSTs JSON to
`https://api.resend.com/emails` with `fetch`. No new npm dependency.**

- The credential is `RESEND_API_KEY`, sent as `Authorization: Bearer …`. It is
  never logged, never echoed in an error, and never put on a span.
- `MAIL_FROM` is the sender, `APP_BASE_URL` is what links are composed from. Both
  are required at boot when this transport is selected, per ADR 0007; so is the
  key. The process refuses to start rather than sending from a default nobody
  chose or composing a relative link.
- `MAIL_TIMEOUT_MS` (default 4000) bounds each attempt via
  `AbortSignal.timeout`. One retry, after a fixed 1s delay, and only for a network
  error, a timeout, `429`, or `5xx`. A `4xx` is a configuration fault and is not
  retried. Worst case is 2×timeout + 1s = 9s, inside `SHUTDOWN_GRACE_MS` (10s), and
  a boot rule enforces that relationship rather than trusting the two defaults to
  stay in step.
- Bodies are `text/plain` only. No HTML part, no template engine, no tracking
  pixel, no attachment.
- The transport is named after the provider, not after a protocol. `transport` is a
  metric label and it should say what actually carried the message.

**The adapter is provider-shaped on purpose and is not abstracted.** It is roughly
forty lines: build a JSON body, POST it, map the status to resolve or reject.
Swapping providers is editing that one file and three environment variable names;
inventing a provider-neutral configuration layer today would be extensibility for a
need nobody has stated, and the `Mailer` interface is already the seam that makes
the swap cheap.

## Consequences

The dependency tree does not change at all, so rule 7 costs this feature nothing
and there is no new supply-chain surface for a capability that carries
credentials.

**A human has to do three things before this can be switched on, and none of them
are code**: create the provider account, verify a sending domain with the DKIM and
SPF records the provider issues, and confirm the plan's limits. Without a domain
whose DNS this project controls there is no legitimate `MAIL_FROM` — a Sevalla
`*.sevalla.app` hostname cannot be DKIM-verified — and mail sent from an
unverified domain is either refused by the provider or filed as spam by the
recipient. This is the prerequisite most likely to stall the rollout, and it is
stated here so it is discovered before the branch is cut rather than after.

**The free tier is a real ceiling.** It is generous relative to this application's
traffic and free of charge, which is why it was preferred over a paid plan, but
registration is rate limited at `AUTH_RATE_LIMIT_MAX` (10/min per IP) and each
registration dispatches a verification mail, so a determined signup flood can spend
a daily quota in minutes. The quota is not a control and must not be treated as
one: exceeding it shows up as `mail_messages_total{outcome="failed"}` and delivers
nothing, including password resets. Watching that counter is the mitigation;
buying a larger plan is a human's decision.

**We are locked in by about forty lines**, which is the intended amount. If the
provider is unacceptable — pricing, jurisdiction, data processing agreement — the
replacement is one file, three variable names, and the same tests.

Rejected, in the order they are tempting:

- **SMTP via `nodemailer`.** The generic answer, and the one that would let a human
  change provider without changing code. It adds a dependency and its tree for a
  protocol Node cannot speak natively, it needs connection and greeting timeouts
  configured rather than one `AbortSignal`, and it still requires exactly the same
  provider account and domain verification — so it buys portability, not
  independence, and pays for it with egress on a port nobody here has proven is
  open.
- **AWS SES.** Cheapest at volume and already adjacent to nothing this project
  uses. SigV4 signing means the AWS SDK, which is a much larger dependency than
  `nodemailer`, plus an AWS account, IAM policy and a sandbox exit request — three
  human approvals rather than one.
- **A provider-neutral `MAIL_PROVIDER` abstraction with two implementations.**
  Extensibility for a need nobody stated. There is one provider; a second one is a
  second decision, made when it exists.
- **A self-hosted SMTP server.** Deliverability from a new IP in a Kubernetes
  cluster is a project in itself, and the failure mode is silent spam-foldering.
