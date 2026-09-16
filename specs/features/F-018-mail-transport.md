# F-018 · Real outbound mail transport

> Status is tracked in `specs/features.yaml`, not here.

## Problem

Nothing this application sends is delivered. `MAIL_TRANSPORT=drop` is what staging
and production run, so F-004 issues password-reset tokens no user receives and
F-005 issues verification tokens no user can confirm. Both features are correct,
tested, and inert: a locked-out user is still locked out, and every account in
production is permanently unverified. The only signal that this is happening is
`mail_messages_total{transport="drop"}` climbing while nothing is ever consumed.

F-017 has since made this ordering explicit: it will not ship a "Forgot your
password?" link into an application that answers "a reset link is on its way" when
nothing will ever arrive, so `F-018` sits in its `deps`. This feature is what
unblocks it.

## Scope

**In scope**

- One transport that actually delivers, selected by a new `MAIL_TRANSPORT` value,
  with its own timeout and no change to the `Mailer` interface's contract
- Credentials and configuration for it in both deployed environments, failing
  closed at boot per ADR 0007
- `APP_BASE_URL` and the link format `<APP_BASE_URL>/#reset=<token>` (ADR 0028)
- The message body for `password_reset`
- The rules that stop the e2e suite from mailing reserved domains, and that
  withhold the verification kind until something can consume its link (ADR 0030)

**Out of scope**

- Changing either flow's endpoints, tokens, or response contracts
- An outbox table, a queue, or a delivery worker (ADR 0010 states the cost of not
  having one: a message can be lost if the process dies between the response and
  the send)
- Enforcing email verification anywhere — that is a separate product decision and
  carries the boot rule in ADR 0011
- Bounce and complaint webhooks. A provider webhook is a public endpoint with
  signature verification, a suppression table, and a feedback loop into F-005's
  column. It is a feature, not a paragraph, and nobody has asked for it; the
  provider's own dashboard reports bounces in the meantime
- HTML message bodies, templates, tracking pixels, unsubscribe headers
- Marketing, digests, or any mail not triggered by an authentication flow
- **The "your password was changed" notification** and **the email-verification
  screen** — both split out, see "Backlog split"

## Design

### The transport

**[ADR 0029 · Mail leaves over the provider's HTTPS API, not SMTP](../../docs/adr/0029-mail-leaves-over-the-providers-https-api.md)**
carries the provider choice and the three rejected alternatives (`nodemailer` over
SMTP, AWS SES, a provider-neutral abstraction).

`src/lib/mailer.ts` gains a third implementation next to `ConsoleMailer` and
`DropMailer`. The `Mailer` interface is unchanged — same two methods, same
signatures, same contract — which is the whole reason ADR 0010 put the seam there.

```ts
class ResendMailer implements Mailer {
  readonly transport = 'resend';
  constructor(
    private readonly config: Config,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  // sendPasswordReset → composes the link, calls send()
  // sendEmailVerification → suppressed, see ADR 0030
}
```

`createMailer` becomes a three-way switch on `MAIL_TRANSPORT`. Nothing else in
`src/` changes: no route, no schema, no plugin, no `BuildOptions` field. The
`fetchImpl` parameter is the unit-test seam and defaults to global `fetch`; it is
not exposed through `BuildOptions`, because no integration test needs it (see the
test plan).

One send is one `POST https://api.resend.com/emails`:

| Part    | Value                                                                      |
| ------- | -------------------------------------------------------------------------- |
| headers | `Authorization: Bearer <RESEND_API_KEY>`, `Content-Type: application/json` |
| body    | `{ from: MAIL_FROM, to: [address], subject, text }`                        |
| signal  | `AbortSignal.timeout(MAIL_TIMEOUT_MS)`                                     |

`2xx` resolves. Anything else rejects with an error carrying the status code and
nothing else — never the response body, which can echo the recipient, and never
the key.

### Retries, and what a failure does

One retry, after a fixed 1s delay, for a network error, a timeout, `429`, or any
`5xx`. A `4xx` is not retried: an invalid key, an unverified `MAIL_FROM` or a
malformed body will fail identically the second time, and the provider's
documented 2 requests/second limit is exactly what the `429` branch is for.

A retry cannot produce a duplicate that matters. The token is generated and stored
before the send, so both attempts carry the same link; a user who receives two
copies has one working token, not two.

Worst case is `2 × MAIL_TIMEOUT_MS + 1000` = 9s with the defaults, against
`SHUTDOWN_GRACE_MS` = 10s. A boot rule enforces the relationship rather than
trusting two defaults to stay in step, because the failure it prevents — a SIGTERM
killing an in-flight retry — is invisible.

**The route is unchanged, and mail failure stays fail-open.** This is the question
the stub asked and the answer is ADR 0010's, restated because a live transport is
the first time it has teeth:

- `POST /api/auth/register` returns `201` whether or not the verification mail
  leaves. Nothing is gated on verification (ADR 0011), and a provider outage must
  not be a signup outage.
- `POST /api/auth/password-reset` returns `202` whether or not the reset mail
  leaves. Fail-closed is not merely undesirable here, it is unavailable: the
  response is dispatched before the send is attempted, and a status that could
  differ on the known-address branch is the enumeration oracle the identical
  response exists to close.

So a user can be told "check your mail" for a message that failed. The
compensations are the ones ADR 0010 named and this feature makes real: the failure
is counted, the counter is alerted on, and the user may ask again after the
60-second cooldown.

### Configuration

Five keys. All of them are inert unless `MAIL_TRANSPORT=resend`.

| Key               | Type / default                                 | Notes                                                                              |
| ----------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| `MAIL_TRANSPORT`  | `console \| drop \| resend`, default `console` | Existing key, one new value                                                        |
| `RESEND_API_KEY`  | string, default `''`                           | **Credential.** Never logged, never in an error message, never on a span           |
| `MAIL_FROM`       | string, default `''`                           | `Agentic Todo <noreply@example-domain>`; must contain `@`, must contain no newline |
| `APP_BASE_URL`    | string, default `''`                           | Absolute origin the links are composed from                                        |
| `MAIL_TIMEOUT_MS` | int 100..10000, default 4000                   | Per attempt                                                                        |

Boot rules, in a `validateMail(config)` alongside `validateRedis` and
`validateTracing`, all ADR 0007 shaped and all throwing in **every** `NODE_ENV`:

1. `MAIL_TRANSPORT=resend` with an empty `RESEND_API_KEY`, `MAIL_FROM` or
   `APP_BASE_URL` → refuse to boot, naming the missing variable. This is the case
   ADR 0007 was generalised for.
2. `APP_BASE_URL` that is not an absolute `http(s)` URL, or that carries a query,
   a fragment, or a path other than `/` → refuse to boot. The link format is
   `<base>/#reset=<token>` with nothing after the token (ADR 0028); a base URL
   with a path or an existing fragment silently produces a link the page ignores.
3. `APP_BASE_URL` on plaintext `http:` to a non-loopback host under
   `NODE_ENV=production` → refuse to boot, mirroring the OTLP rule in
   `validateTracing`.
4. `MAIL_FROM` without an `@`, or containing a newline → refuse to boot.
5. `2 × MAIL_TIMEOUT_MS + 1000 > SHUTDOWN_GRACE_MS` while `MAIL_TRANSPORT=resend`
   → refuse to boot, naming both variables.

And one rule deliberately **not** written: `RESEND_API_KEY` set while
`MAIL_TRANSPORT` is not `resend` is **a warning, not a boot failure**. The
precedent points the other way — `OTEL_EXPORTER_OTLP_HEADERS` without an endpoint
refuses to boot — and it is departed from on purpose, in the same way
`validateRedis` documents its missing third rule. The rollback for a misbehaving
transport must be one variable: set `MAIL_TRANSPORT=drop` and redeploy. If a
leftover key also had to be unset, a 2am rollback would be a boot failure, the
container would never become ready, and Sevalla would keep serving the previous
revision — which is still sending mail. A rollback that leaves the thing you are
rolling back running is worse than an unused credential sitting in an environment.
The boot line says `unusedMailCredential: true` so the state is visible.

`.env.example` gains all five with comments. `scripts/dump-openapi.ts` needs no
change: it already pins `MAIL_TRANSPORT: 'drop'`, and none of the new keys is
required under it. `tests/integration/helpers.ts` needs no change for the same
reason.

### The message

Plain text, one kind, composed in the transport — the adapter still takes a raw
token and nothing else, exactly as F-004 designed it.

```
Subject: Reset your Agentic Todo password

Someone asked to reset the password for this address.

Open this link to choose a new one. It expires at 2026-09-16 14:07 UTC:

https://app.example/#reset=<43-character token>

If this was not you, ignore this message — your password has not changed and
nobody was told whether this address has an account.
```

The link is `${APP_BASE_URL}/#reset=${token}` with any trailing slash on the base
stripped first, and **nothing after the token**. That is the contract ADR 0028
fixed and F-017's client enforces with `^[A-Za-z0-9_-]{43}$`; a trailing period, a
wrapping `<…>`, a tracking redirect or a query parameter all produce a link that
lands on a page which ignores it.

Rejected: an HTML part (a second body to escape a token into, a rendering surface
to test, and no benefit for four sentences), a display name for the recipient
(this application has none), and any link other than the reset link — no
unsubscribe, no dashboard, no support address that does not exist.

### Declining to send

**[ADR 0030 · A transport may decline to send, and says so in the metric](../../docs/adr/0030-a-transport-may-decline-to-send.md)**
carries both rules and the four rejected alternatives.

1. Recipients in RFC 2606 reserved domains (`example.com/.net/.org`, `.test`,
   `.example`, `.invalid`, `.localhost`) are never sent to. This is what makes it
   safe to run the real transport on staging, where `e2e/helpers.ts` mints
   `web-…@example.com` at 23 call sites on every deploy.
2. `sendEmailVerification` is withheld entirely, because
   `POST /api/auth/verify-email/confirm` takes its token in a request body and no
   browser surface exists that can post one. Ends with F-026.

Both increment `mail_messages_total{outcome="suppressed"}` and log a `reason`.

### Data model changes

**None.** No table, no column, no index, no migration, and therefore no
expand/contract plan and nothing for `scripts/ci/migration-safety.mjs` to check.
The transport reads a token that F-004 and F-005 already generate and store; it
persists nothing of its own. A delivery-status table is what an outbox would
need, and there is no outbox (ADR 0010).

### API surface

**None.** No route added, changed or removed; no request or response schema
touched; `openapi.json` is byte-identical and `npm run openapi:check` passes
without a regeneration. This is infrastructure behind an existing seam, and the
deployed API surface must keep matching the committed spec.

### Key decisions

Beyond the two ADRs:

**The transport is enabled by configuration, not by merge.** The code ships with
every environment still on `drop`; switching staging is a Sevalla environment
change and a redeploy. That keeps "the code is live" and "mail is live" as two
separate, separately reversible events, the same shape F-011 and F-012 used.

**No client-side rate limiter in front of the provider.** The application's
existing limits are what bound spend: `PASSWORD_RESET_RATE_LIMIT_MAX` 5/hour/IP
plus the 60-second per-account cooldown for resets, `AUTH_RATE_LIMIT_MAX` 10/min/IP
for registrations. Adding a second, mail-specific budget means a shared counter
nobody has bought (ADR 0018) or a per-instance one that lies. Rejected in favour of
watching `mail_messages_total{outcome="failed"}`, which is what a quota breach
looks like. **This is the weakest point in the design and is stated so it can be
rejected**: registration bursts are the one path that can spend a daily quota
faster than a human will notice, and the blast radius of an exhausted quota
includes password reset.

**No `Idempotency-Key` on the provider request.** The retry carries the same
token, so a duplicate is a duplicate copy of one valid link. Adding a key would be
protecting against a harmless outcome.

**No new metric series.** `mail_messages_total` already carries `kind`,
`transport` and `outcome`; this feature adds one label _value_ to each of the
latter two. A `mail_send_duration_seconds` histogram was considered and rejected:
a slow provider is already visible as a timeout in `failed`, and the send is off
the response path, so its latency does not belong in any user-facing SLO.

### Backlog split

Two things the stub parked here are split out, because keeping them would put this
feature over the diff guidance and because each carries a decision of its own.

**F-026 · Web UI — email verification screen** (`deps: [F-005, F-006, F-018]`,
`risk_tags: [frontend, auth]`). The `#verify=<token>` screen ADR 0028 anticipated,
plus deleting rule 2 of ADR 0030 so verification mail starts flowing. It is a
browser feature — screen, copy, focus handling, e2e journey — and it belongs next
to F-017 in the web half of the backlog, not inside a transport.

**F-027 · "Your password was changed" notification mail** (`deps: [F-018]`,
`risk_tags: [email, security]`). F-004 parked it on F-005, F-005 parked it here.
It is a third `Mailer` method, a change to the CODEOWNERS-protected
`src/routes/auth.ts`, a new metric `kind`, and its own questions — does it carry a
"this wasn't me" action, does it fire for a future authenticated password change,
what does it do when the notification itself fails. None of that is the transport,
and none of it is needed to unblock F-017.

What remains here is the thing F-017 is actually waiting for: mail that arrives.

## Acceptance criteria

Each names the test that proves it.

- [ ] `createMailer` returns the delivering transport when `MAIL_TRANSPORT=resend`,
      and `sendPasswordReset` issues exactly one `POST` to
      `https://api.resend.com/emails` with `Authorization: Bearer <key>` and a JSON
      body whose `from` is `MAIL_FROM` and whose `to` is the recipient —
      `unit: the resend transport posts one message to the provider`
- [ ] The `text` body contains exactly `<APP_BASE_URL>/#reset=<token>`, once, with
      nothing appended, and a trailing slash on `APP_BASE_URL` does not produce
      `//#reset=` — `unit: the reset link matches the format F-017's client parses`
- [ ] A `200` resolves; a `422` rejects **without a second request**; a `500`, a
      `429`, a network error and a timeout each cause **exactly two** requests and
      then reject — `unit: only transient provider failures are retried once`
- [ ] An attempt that outlives `MAIL_TIMEOUT_MS` is aborted rather than hanging —
      `unit: a provider that never answers is abandoned at the timeout`
- [ ] A recipient at `@example.com` (and `.test`, `.invalid`, `.localhost`,
      `.example`) causes **no** request to the provider —
      `unit: reserved domains are never sent to`
- [ ] `sendEmailVerification` causes no request to the provider on the delivering
      transport — `unit: verification mail is withheld until a screen exists`
- [ ] Neither `RESEND_API_KEY` nor the raw token appears in any thrown error
      message, any log line, or any metric label —
      `unit: a provider failure reports a status and nothing else` and the existing
      `integration: logs never contain the token or the address` scan
- [ ] The process refuses to boot when `MAIL_TRANSPORT=resend` and any of
      `RESEND_API_KEY`, `MAIL_FROM`, `APP_BASE_URL` is empty, in every `NODE_ENV`,
      with an error naming the variable and never echoing the key —
      `unit: config refuses a delivering transport without its credential`
- [ ] The process refuses to boot on an `APP_BASE_URL` that is relative, carries a
      path/query/fragment, or is plaintext `http:` in production, and on a
      `MAIL_FROM` with no `@` or with a newline —
      `unit: config refuses a base URL that would produce an unusable link`
- [ ] The process refuses to boot when `2 × MAIL_TIMEOUT_MS + 1000` exceeds
      `SHUTDOWN_GRACE_MS` on the delivering transport —
      `unit: the retry budget must fit inside the shutdown grace`
- [ ] `RESEND_API_KEY` set while `MAIL_TRANSPORT=drop` boots, and says so —
      `unit: an unused mail credential warns and does not fail the boot`
- [ ] `drop` remains available, remains the default in
      `tests/integration/helpers.ts` and `scripts/dump-openapi.ts`, and `console`
      still refuses production — existing
      `integration: the drop transport keeps the API surface intact` and
      `integration: the console mail transport refuses to run in production`,
      both unchanged
- [ ] A mailer whose send rejects does not change any HTTP response:
      `POST /api/auth/register` still returns `201` and
      `POST /api/auth/password-reset` still returns `202`, and
      `mail_messages_total{outcome="failed"}` increments for each —
      `integration: a failing mailer does not fail the request`
- [ ] `openapi.json` is unchanged and `npm run openapi:check` passes with no
      regeneration — CI
- [ ] A real reset mail arrives in a real mailbox from staging, and its link
      completes the reset — the manual step in "Rollout", recorded on the PR.
      This is the one criterion CI cannot prove, by construction

## Test plan

| Layer       | Cases                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unit        | `tests/unit/mailer.test.ts` (new), against an injected `fetchImpl`, **never the network**: request shape (URL, method, bearer header, content type, `from`/`to`/`subject`/`text`) · link composition, with and without a trailing slash on `APP_BASE_URL`, asserted against `^…/#reset=[A-Za-z0-9_-]{43}$` · retry matrix (200, 400, 422, 429, 500, network throw, abort) counting calls · timeout aborts · reserved-domain suppression for each listed domain · verification kind suppressed · error text carries a status and neither key nor token · `createMailer` returns the right class for all three values. `tests/unit/config.test.ts` (extended): the five boot rules, each asserted on message content, plus the unused-credential warning path |
| integration | `tests/integration/password-reset.test.ts` and `email-verification.test.ts` (extended), through the existing injected-fake seam — no provider, no network: a mailer that rejects leaves `202`/`201` unchanged and increments `mail_messages_total{outcome="failed"}`; a mailer that hangs past the handler does not delay the response. The existing `drop`/`console` cases stay exactly as they are                                                                                                                                                                                                                                                                                                                                                        |
| e2e         | **None, deliberately.** Playwright has no way to read a raw token (ADR 0010), the suite runs against staging where reading one is impossible anyway, and `test.skip` is forbidden — F-017 makes the full argument. Nothing here has a browser surface. The e2e suite's _interaction_ with this feature is that its `@example.com` registrations must never reach the provider, and that is proved at the unit layer where it is cheap and deterministic                                                                                                                                                                                                                                                                                                     |
| load        | **None.** `load/soak.js` does not touch the auth mail routes, and adding a scenario that did would spend provider quota to measure a send that is off the response path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

**Why CI cannot prove delivery, and what stands in for it.** There is no live
external service access in CI and there should not be: a test that needs
`api.resend.com` is a test that fails on a provider outage, spends quota, and
cannot run on a fork. The seam is the injected `fetchImpl`, which proves everything
except that the provider does what its documentation says. That last gap is closed
once, by hand, during the staging rollout below, and it is written down as an
acceptance criterion rather than pretended away.

**No CODEOWNERS-protected file is edited by this feature.** But one is already
broken and this feature is the reason to notice: `.github/workflows/nightly.yml`
runs the soak app with `NODE_ENV=production` and no `MAIL_TRANSPORT`, so it gets
the `console` default, `ConsoleMailer` throws at construction, and the app never
becomes ready. The nightly soak has failed at that line every night since F-004
merged (run 35050286360 and its predecessors). The fix is one line —
`MAIL_TRANSPORT: drop` in that `env:` block — and it needs a human, because
`/.github/` is protected and AGENTS.md rule 1 forbids an agent editing it.

## Security considerations

**The credential.** `RESEND_API_KEY` grants "send mail as this domain" to whoever
holds it. It lives only in the Sevalla environment of each app, different values
per environment, never in `.env.example` (rule 6), never in a workflow file, never
logged, and never included in an error message — the transport's error carries the
HTTP status and nothing else, because a provider error body can quote the
recipient address. Rotation is a provider-side key rotation plus one environment
update; no code change, and the old key stops working when it is revoked.

**The message body carries a credential by design.** A reset token in an inbox for
30 minutes is the flow's premise (ADR 0009, ADR 0028) and mailbox possession is
the authentication factor. What this feature adds is a third party who can read it:
the provider stores message content. That is inherent to using one, it is the
reason `PASSWORD_RESET_TTL_MINUTES` is 30 rather than a day, and it is the reason
the only thing in the body is the link — no account details, no PII beyond the
address the provider must already see to deliver.

**New egress.** The process now makes outbound HTTPS calls to a third-party host
from the same container that holds the database credential. The call is
`AbortSignal`-bounded, it is made only from the mailer, and the URL is a constant —
not composed from any user input, so there is no SSRF surface.

**Header/parameter injection.** The body is JSON built by `JSON.stringify`, not an
SMTP envelope, so CRLF in a value cannot forge a header. `MAIL_FROM` is still
newline-checked at boot (cheap, and it stops a confusing misconfiguration), and the
recipient is already `z.string().email().max(254)` at both call sites.

**Enumeration.** Unchanged, and preserved on purpose. The response and its timing
do not depend on whether a send happened, because the send is not awaited. The
counter still distinguishes the branches, which is why `/metrics` is behind
`METRICS_TOKEN` (F-004) — that control now guards a live signal rather than a
theoretical one.

**Reputation as a security property.** A provider account suspended for bouncing
into reserved domains takes password reset down with it, so ADR 0030's rule 1 is an
availability control, not hygiene.

**PII.** No new personal data is stored. One existing category — the email address
— is now disclosed to a new processor, which is a GDPR Art. 28 matter: the
provider needs a data processing agreement, and the privacy notice needs to say
mail is sent by a sub-processor. That is a human's task, flagged on the issue.

## Observability

- **`mail_messages_total{kind,transport,outcome}`** — existing counter, now
  load-bearing. New label values `transport="resend"` and `outcome="suppressed"`.
  `outcome="failed"` is the page-worthy series ADR 0010 predicted: the user already
  has their `202`, so nothing else surfaces a delivery failure. Suggested alert:
  any `failed` in a 15-minute window on a delivering transport, and separately
  `sent` flat at zero for `password_reset` over a day when `password_reset_tokens`
  issuance is not — which is what a silently revoked key looks like.
- **`outcome="suppressed"` is expected, not healthy.** On staging it will dominate,
  and a rising `suppressed{kind="password_reset"}` in production means real users
  are typing reserved domains. Do not alert on it; do look at it when `sent` drops.
- **`password_reset_tokens_total{outcome="consumed"}`** stops being structurally
  zero the day this is switched on. F-017 records it as the arrival signal: issued
  climbing while consumed stays at zero, after both features are live, is the
  "mail is not arriving" alarm.
- **One structured log line per send**, at `info` for `sent`/`suppressed` and
  `error` for `failed`:
  `{ mail: { kind, transport, outcome, reason?, status?, attempts, durationMs } }`.
  No address, no token, no key, no message body — the existing
  log-content scan in the integration suite covers the first two.
- **One boot line**, next to the existing `rate limiter ready` / `todo list cache
ready` lines: `mail transport ready { transport, appBaseUrl, verificationWithheld,
unusedMailCredential }`. "Is mail live right now, and where do its links point"
  must be answerable from logs without reading the environment.
- **`http_request_duration_seconds{route="/api/auth/password-reset"}`** must stay
  flat and unrelated to provider latency. If its p95 starts tracking the provider,
  someone has awaited the send.
- **Not measured:** delivery, opens, bounces, complaints. The provider's dashboard
  has them; nothing in this application reads them (see "Out of scope").

## Rollout

**Prerequisites, all human, all before the branch is cut:**

1. Create the provider account. Decide the plan — the free tier is expected to
   cover this application's volume, and exceeding it is a billing decision nobody
   has made.
2. **Own a sending domain and verify it** (DKIM + SPF records the provider
   issues). This is the prerequisite most likely to stall everything: a Sevalla
   `*.sevalla.app` hostname cannot be DKIM-verified, so without a domain whose DNS
   this project controls there is no legitimate `MAIL_FROM`, and mail from an
   unverified sender is refused or spam-filed.
3. Sign the provider's data processing agreement and update the privacy notice.
4. Create **two** API keys, one per environment, sending-scoped only.

**Order.**

1. **Merge with every environment still on `drop`.** Nothing new is required at
   boot while `MAIL_TRANSPORT=drop`, so the deploy is inert by construction: the
   code ships, the behaviour does not change, and the rollback for the merge is
   the ordinary redeploy of the previous image.
2. **Staging, in one environment update**: `MAIL_TRANSPORT=resend`,
   `RESEND_API_KEY`, `MAIL_FROM`, `APP_BASE_URL=<STAGING_URL>`. Redeploy. If any is
   missing the container refuses to start and Sevalla holds the previous revision —
   safe, and the boot error names the variable.
3. **First hour on staging**, watching in this order: the `mail transport ready`
   line reads `transport: resend`; register a mailbox you control and complete a
   full reset from the link; run the Playwright suite and confirm `suppressed`
   climbs while `sent` does not; `failed` stays at zero. Record the manual reset on
   the PR — it is the acceptance criterion CI cannot prove.
4. **Production after 24 clean hours on staging**, same four variables with
   `APP_BASE_URL=<PRODUCTION_URL>` and the second key. Then watch `failed`,
   `sent{kind="password_reset"}` and the consumed counter for an hour.
5. **F-017 unblocks here**, and only here. Its screens are what turn a working
   transport into a user-visible recovery path.

**Rollback at 2am.** Set `MAIL_TRANSPORT=drop` and redeploy: one variable, no code
change, no migration to undo, and the application returns to exactly today's
behaviour. The leftover key is why the sixth boot rule — "a credential with
nothing to use it refuses the boot" — was deliberately not written; see
"Configuration". If the problem is the link rather than delivery, `APP_BASE_URL` is
separately correctable without touching the transport.

**Follow-ups this creates:**

- **F-026** — the email-verification screen, which deletes ADR 0030's rule 2.
- **F-027** — the "your password was changed" notification.
- **`.github/workflows/nightly.yml`** — add `MAIL_TRANSPORT: drop`; the soak has
  been red since F-004 and no agent may edit that path.
- **Bounce and complaint handling**, deliberately unowned: raise it as a feature if
  the provider dashboard shows it is needed.

**Diff budget.** Estimated ~455 hand-written lines: `src/lib/mailer.ts` (~130),
`src/config.ts` (~70), `.env.example` (~22), `tests/unit/mailer.test.ts` (~160),
`tests/unit/config.test.ts` (~45), integration additions (~30), plus
`docs/deployment-sevalla.md` (~45, docs) and the two ADRs (docs). Under the ~500
guidance, and the reason both the notification mail and the verification screen
were split out. If it runs over, cut the boot rule on the retry budget (rule 5)
first — never the suppression rules or their tests, which are what make a live
transport safe to enable on staging.
