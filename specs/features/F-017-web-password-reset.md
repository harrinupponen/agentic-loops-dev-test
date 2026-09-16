# F-017 · Web UI — password reset screens

> Status is tracked in `specs/features.yaml`, not here.

## Problem

F-004 builds the password-reset API but no browser can reach it. A user who
forgets their password still sees only a sign-in form with no way forward, so the
problem F-004 set out to solve — "permanently locked out" — is not actually solved
for a human being. F-006 anticipated this and put reset screens out of scope
because the API did not exist yet.

## Scope

**In scope**

- A "Forgot your password?" entry point on the signed-out panel
- A request screen that posts an address to `POST /api/auth/password-reset` and
  shows the same confirmation regardless of the outcome
- A reset screen that reads a token from the page URL and posts it, with the new
  password, to `POST /api/auth/password-reset/confirm`
- Surfacing `invalid_token`, `token_expired`, `validation_failed`, and `429`
- The browser end-to-end journey F-004 could not have: request → reset → sign in
  with the new password

**Out of scope**

- Any change to the F-004 endpoints or their responses
- Email templates, link formats for any client other than this one
- Authenticated password change
- **The mail that carries the link.** F-018 owns the provider adapter,
  `APP_BASE_URL` and the message body. This feature defines the **link format**
  F-018 must compose (`<APP_BASE_URL>/#reset=<token>`) and adds no configuration
  key of its own. See "Backlog and shipping order".
- **A screen for F-005's email-verification token.** It has the same shape and
  ADR 0028 records that the fragment mechanism generalises to it, but nothing for
  it is built here and no backlog id is invented for it.
- A "confirm new password" second field, a password-strength meter, and a
  show-password toggle. Each is argued and rejected under "Key decisions".
- Client-side routing, a history entry per screen, or a catch-all HTML route.
  ADR 0006 stands; the one `history.replaceState` call is a scrubber, not
  navigation (ADR 0028).

## Design

### API changes

**None.** No route is added, changed, renamed or hidden; `openapi.json` is
byte-identical and `npm run openapi:check` stays green without touching it. There
is no new config key, no new server file, and no new dependency — so
`package-lock.json` is unchanged and this PR needs no dependency justification.
This feature is a client of the API exactly as F-004 left it, the position F-016
shipped in.

The browser calls two existing endpoints:

| Method | Path                               | Auth | Used for             | Handled failures                                                                         |
| ------ | ---------------------------------- | ---- | -------------------- | ---------------------------------------------------------------------------------------- |
| POST   | `/api/auth/password-reset`         | none | request a link       | `400 validation_failed` · `429` · `5xx` — **none of them change the confirmation shown** |
| POST   | `/api/auth/password-reset/confirm` | none | set the new password | `400 invalid_token` · `400 token_expired` · `400 validation_failed` · `429` · `5xx`      |

Both are `POST` to the same origin, so `SameSite=Lax`, the CSP's
`connect-src 'self'` and `src/app.ts`'s Origin allowlist all apply unchanged.
Neither call carries a session cookie that matters: both endpoints are public, and
the reset screen works identically whether or not the browser holds a session.

### The link, and why it is a fragment

`<APP_BASE_URL>/#reset=<43-character base64url token>`

That is the whole format, and it is the contract F-018 must compose. The
reasoning is **[ADR 0028](../../docs/adr/0028-a-recovery-link-arrives-in-the-fragment.md)**;
the four properties that made it win:

1. **No new route and no catch-all.** `GET /` already serves the shell. F-006
   rejected an SPA fallback by name as the one construct that can make an API path
   return HTML, and this requirement — the first inbound deep link in the
   application — does not need one.
2. **A fragment is never sent to a server.** It is not in the request line, so a
   live credential cannot reach an access log, and browsers strip it from
   `Referer`. F-004 forbids the token reaching the server in a query string and
   records that honouring it is this feature's job; this is how it is honoured.
3. **The page scrubs it before the user can act.** On load the client parses
   `location.hash`, keeps the token in a module-scope variable, and calls
   `history.replaceState(null, '', location.pathname)` before rendering the
   screen. Nothing after that moment — the address bar, the history entry, a
   bookmark, a screenshot, a screen share — carries it.
4. **Only a `POST` with a password in it consumes a token.** A mail-provider link
   scanner, a corporate gateway that prefetches URLs, or a browser prerender loads
   a page and burns nothing. Under ADR 0009's one-live-token-per-account rule a
   token burned by a scanner would be indistinguishable, to the user, from a bug.

The cost, stated rather than discovered: **a reload loses the token.** After the
scrub the URL is plain `/`, so refreshing the reset screen — or pressing back —
returns the user to the sign-in form with the half-filled form gone. The link is
still in their inbox. This is accepted; the alternative is leaving a live
credential in the address bar for as long as the tab is open.

### Data model changes

**None.** No table, column, index, migration or backfill, therefore no expand step
and no contract step, and no ordering constraint against any other feature's
schema. This feature is the second since F-010 (after F-015) that does not have to
route around issue #11 — the guard in `scripts/ci/migration-safety.mjs` and the
transaction-wrapped runner in `src/db/migrate.ts` are still in conflict while the
issue reads closed, and this design simply never gets near them. **#11 should
still be reopened**, for the eighth time of asking.

No persistent client state either: **nothing is written to `localStorage`,
`sessionStorage` or a readable cookie** — least of all the token, which lives in a
module-scope variable for the life of the page and nowhere else. That is F-006's
rule and it is load-bearing here for the first time, because for the first time
the client is holding a credential.

### File layout

```
web/index.html                       + two sections and one button (~45 lines of markup)
web/styles.css                       + nothing new structurally; reuses .alert and form styles
web/src/reset.ts                     NEW — DOM-free: fragment parsing, the two calls, the copy decisions
web/src/reset-panel.ts               NEW — the DOM: the two screens, their forms and alert regions
web/src/main.ts                      + a fourth and fifth panel in the existing switch, + the boot branch
tests/unit/password-reset-client.test.ts  NEW — reset.ts with a stubbed fetch, node env
e2e/web-password-reset.spec.ts       NEW — three browser specs
```

The DOM-free / DOM split is the one ADR 0006 forced and F-016 repeated: the unit
project runs in the node environment with no jsdom, so everything unit-testable
must not reference `document`. `web/src/reset.ts` therefore owns the fragment
parser, the two typed calls and — following `resolveToggle`'s precedent — the
**pure decision functions** that say what the screen should show next. That is
what makes the copy for every error branch testable without a browser, which
matters because the browser cannot reach the success branch at all (see "Why the
happy path has no e2e").

`web-source-safety.test.ts` covers both new files with no change to it: the sink
scan already walks all of `web/`, and the `byId()` id-existence scan already walks
all of `web/src`.

### Markup added to `index.html`

Two new sections, siblings of `#signed-out` and `#signed-in`, both `hidden` in the
static markup, plus one button inside the signed-out panel. All of it is static;
none of it is generated.

```
<button id="forgot-password" type="button">           inside #signed-out, under the sign-in form

<section id="reset-request" hidden>
  <h2>Reset your password</h2>
  <p id="reset-request-alert" class="alert" role="alert" aria-live="polite" tabindex="-1" hidden>
  <p id="reset-request-status" role="status">          the confirmation, or empty
  <form id="reset-request-form" aria-label="Reset password" method="post"
        action="/api/auth/password-reset">
    label + input#reset-email  (type=email, autocomplete=email, maxlength 254, required)
    button[type=submit]  "Send reset link"
  <button id="reset-request-back" type="button">Back to sign in</button>

<section id="reset-confirm" hidden>
  <h2>Choose a new password</h2>
  <p id="reset-confirm-alert" class="alert" role="alert" aria-live="polite" tabindex="-1" hidden>
  <p id="reset-confirm-status" role="status">
  <form id="reset-confirm-form" aria-label="Choose a new password" method="post"
        action="/api/auth/password-reset/confirm">
    label + input#reset-password  (type=password, autocomplete=new-password,
                                   minlength 12, maxlength 200, required)
    <p>At least 12 characters. Requesting a newer link stops this one working.</p>
    button[type=submit]  "Set new password"
  <button id="reset-request-again" type="button" hidden>Request a new link</button>
```

The `method`/`action` attributes mirror F-006's existing forms for consistency;
`event.preventDefault()` means they never fire, and `form-action 'self'` blocks
them going anywhere else if they somehow did. A no-JavaScript submit of the
confirm form would post an empty token (the fragment is not part of a form
submission) and get a JSON `400` — ugly, harmless, and unreachable in practice
since nothing on the page works without the module.

The static hint "Requesting a newer link stops this one working" is where
**ADR 0009's cost lands in copy**. It is deliberately in the markup rather than in
an error path: by the time a user sees `invalid_token` it is too late to explain
the rule, and the number (30 minutes, `PASSWORD_RESET_TTL_MINUTES`) is server
configuration the client must not restate.

### Client behaviour

**Boot.** `main.ts` parses `location.hash` **before** the `GET /api/auth/me`
bootstrap, because the token decides which screen is shown and must be scrubbed
from the URL as early as possible:

| `location.hash`                  | What happens                                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------------------------------- |
| absent, or anything else         | Nothing changes. The existing bootstrap runs exactly as it does today.                               |
| `#reset=<43 valid chars>`        | Scrub, hold the token in memory, show `#reset-confirm`. The `/api/auth/me` bootstrap is **skipped**. |
| `#reset=` with a malformed token | Scrub, show `#reset-request` with "That reset link is not complete…". **No request is sent.**        |

**A token wins over a session.** If the browser holds a live cookie and a reset
link is opened, the reset screen is shown and the todo panel is never mounted.
That is the correct order: confirming destroys every session for the account
anyway (F-004), so signing the user into a session that is about to be deleted
would be theatre. Skipping the bootstrap also means the reset screen makes exactly
one request in its life — the confirm — which is what the e2e asserts.

**Malformed tokens never reach the server.** The shape check is
`^[A-Za-z0-9_-]{43}$`, the same regex as `RecoveryTokenSchema`. This is not
client-side validation for politeness: `POST /api/auth/password-reset/confirm`
hashes the submitted password with argon2 **before** it knows whether the token is
valid — F-004's timing equalisation — so every mangled link that reaches it costs
~19 MiB and ~50 ms of server CPU. A mail client that wraps a long line is a
plausible source of volume here.

**Request screen.** Submit disables the button (the double-submit guard F-006
established), posts `{ email }`, and on **any** outcome that is not a failure the
screen renders one module constant:

> If that address has an account, a password reset link is on its way. Check your
> inbox, and your spam folder.

The constant does not depend on the response body, because there is no response
body: F-004 returns `202` with nothing in it for a known and an unknown address
alike. **The client could not distinguish them if it wanted to**, which is the
strongest form this property can take, and it is why the acceptance criterion for
it is a unit test over one constant rather than a comparison of two renderings.
The copy also survives ADR 0009's 60-second per-account cooldown: it promises that
a link exists, not that a new one was just sent, and under the cooldown the earlier
link is still valid.

**Reset screen.** Submit disables the button, posts `{ token, password }` — the
token from memory, never from the URL, never in the path or query string — and on
`204`:

> Your password has been changed and you have been signed out everywhere. Sign in
> with your new password.

The panel then returns to the signed-out state: `unmountTodoList()` runs (so a
session that existed before the reset leaves no rows on screen), the sign-in form
is shown, and the message is rendered above it. No session is created by the reset
(F-004 is explicit about that), so the user signs in — which is also the step that
proves the new password works.

**Errors.** F-006's `showAlert` rules verbatim, one alert region per panel:
`4xx` shows the API's message, `5xx` / unknown / transport failure shows the
generic message plus `requestId`, and focus moves to the region. Two branches are
additive rather than different: the token failures also reveal the "Request a new
link" button, which is the only actionable thing left.

| Outcome                          | Message shown                                                                                 | Extra                         |
| -------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------- |
| `400 invalid_token`              | The API's own: "That reset link is not valid"                                                 | "Request a new link" revealed |
| `400 token_expired`              | The API's own: "That reset link has expired"                                                  | "Request a new link" revealed |
| malformed fragment (client-side) | "That reset link is not complete. Open the link from your email again, or request a new one." | Request screen, no call       |
| `400 validation_failed`          | The API's message verbatim, with its `details` unused by this screen                          | —                             |
| `429`                            | The API's message verbatim ("Too many requests. Retry in N seconds.")                         | —                             |
| `5xx` / `unknown` / network      | `GENERIC_FAILURE` plus `Reference: <requestId>`                                               | —                             |

`invalid_token` and `token_expired` are shown with the server's own wording
rather than client copy, keeping F-006's one rule (4xx messages from this API are
already written for a person) and keeping the two distinguishable without the
client asserting anything about the token's state. What the client adds is the
button, because "what do I do now" is a UI question, not an API one.

### Key decisions

**[ADR 0028 · A recovery link arrives in the fragment, and the page scrubs it](../../docs/adr/0028-a-recovery-link-arrives-in-the-fragment.md)**
carries the link format, the scrub, the POST-only consumption rule and the four
rejected URL shapes (`/reset?token=`, `/reset#token`, a cookie-exchange redirect,
and not scrubbing at all).

**No `APP_BASE_URL` and no config key in this feature.** The page defines the
format it accepts; the thing that needs to render an absolute URL is the mail
transport, which is F-018. Adding the key here would give it exactly one consumer
— the `console` transport's developer output — in exchange for a required `Config`
field, a `.env.example` line, a `scripts/dump-openapi.ts` edit and a value to set
in two Sevalla environments. Rejected as extensibility for a need nobody has
stated yet; a developer completing the flow locally pastes the token from the
`[mail:password-reset]` stdout line into `/#reset=<token>`, and F-018 replaces
that with a real link.

**One password field, no confirmation field.** This is the most arguable line in
the feature and it is stated so it can be rejected cleanly. A mistyped new
password is not silent — it fails at the very next step, the sign-in the flow
already forces (F-004 creates no session), and the recovery path from it is the
same reset the user just used. A second field costs a second input, a second
validation message, a divergence from the server's schema and the classic bug
where paste-blocked confirmation fields make password managers unusable. Rejected
alongside it: a strength meter (the server's 12–200 rule is the authority; a meter
in the client invents a second one) and a show-password toggle (a token-bearing
screen is the worst place to put a credential on screen in plain text).

**The reset screens are panels on the existing page, not routes.** ADR 0006's one
page stands; a fourth and fifth `<section>` toggled by `hidden` is the same
mechanism F-006 used for two. Rejected: a client-side router (needs a catch-all
HTML route — the construct F-006 refused), and a second HTML route for `/reset`
(a route bought for cosmetics, see ADR 0028).

**The token skips the session bootstrap.** Rejected: bootstrapping first and
showing the reset screen only to signed-out visitors, which would leave a
signed-in user clicking a reset link on the todo list with no explanation, and
would make the reset screen's request count depend on whether a cookie happened to
be present.

**A shape check in the browser before any request.** Rejected: sending whatever is
in the fragment and letting the server decide. The server's answer is correct
either way, but it costs an argon2 hash per mangled link (F-004's ordering is
deliberate and documented), and the user-facing message for "your mail client
broke the link" is genuinely different from "this link is not valid".

**No change to `src/routes/auth.ts`, `src/lib/mailer.ts` or any server file.**
Worth stating because the obvious way to make the e2e journey work is to add one —
a test-only route that returns a token, a transport that writes it somewhere
readable. ADR 0010 exists to keep the raw token inside the mailer, and F-004
rejected a token-returning route as an oracle. That is not reopened here; the
consequence is the next section.

### Why the happy path has no e2e, and what stands in for it

The stub asked for `request → reset → sign in with the new password` as a browser
journey. **It cannot be built in this repo**, and the reasoning is F-004's,
sharpened by one year of the suite existing:

1. **The raw token exists only inside the `Mailer`.** The database stores
   `sha256(token)`. Reading it from an HTTP route would be a token oracle
   (ADR 0010), and reading it from the injected fake requires being in the same
   process — which the integration suite is and Playwright is not.
2. **The same specs run against a deployed target.** `deploy.yml` runs
   `npx playwright test` with `E2E_BASE_URL=${{ vars.STAGING_URL }}`, where there
   is no `DATABASE_URL`, no stdout to read and `MAIL_TRANSPORT=drop`. A spec that
   needs a real token passes locally and fails the deploy gate forever.
3. **`test.skip` is forbidden outright** by `scripts/ci/test-integrity.mjs`, so
   "only run it locally" is not available as a per-test decision.
4. **Even a token-free e2e must not submit the request form.** F-004 made this
   argument and it still holds: `PASSWORD_RESET_RATE_LIMIT_MAX` is 5/hour per IP
   and is **not** among the limits staging raises (F-011 records
   `RATE_LIMIT_MAX` and `AUTH_RATE_LIMIT_MAX` overridden to `100000` there, and
   only those two). With `retries: 2`, two shards and several deploys an hour, a
   spec that posts to `/api/auth/password-reset` would eat the budget and then go
   red — on the deploy gate, for the feature whose own control it tripped. So
   **no e2e in this feature submits the request form**, against any target.

The alternative that a reviewer might reasonably prefer, recorded so the choice is
visible: **a second Playwright project, registered only when `E2E_BASE_URL` is
unset**, plus a `MAIL_TRANSPORT=file` transport writing tokens to a temp file the
spec reads. It would buy a real browser proof of the full journey in CI. It is
rejected because it edits `playwright.config.ts` (CODEOWNERS-protected), it makes
the deploy gate run a different suite from the PR gate — which is the property
that makes the gate meaningful — and it adds a third transport whose only purpose
is to write credentials to disk. If you want the journey proved in a browser more
than you want those three properties, say so on the issue; it is roughly 60 more
lines and a protected-file review.

What covers the gap instead:

- **`204` and its whole state transition are a pure function** in `reset.ts`, unit
  tested. What is not proved without a browser is only that the pure decision is
  rendered — and the identical rendering path is proved by the e2e for the
  `invalid_token` branch, which exercises the same alert region, the same panel
  switch and the same focus move.
- **The server half is already green**: F-004's `consumes a token and sets the new
password`, `a token cannot be used twice`, `an expired token is rejected with its
own code` and `a reset does not sign the user in` all exist in
  `tests/integration/password-reset.test.ts` and are untouched by this feature.

### Backlog and shipping order

**This plan adds `F-018` to F-017's `deps`.** The entry becomes
`deps: [F-004, F-006, F-018]`, and that is the line to reject on.

The argument: production runs `MAIL_TRANSPORT=drop` and will until F-018 ships, so
a "Forgot your password?" link merged before it leads to a form that answers "a
reset link is on its way" when **nothing will ever arrive**. Today a locked-out
user finds no path; with these screens and no transport they find a path that
lies, wait for mail, and are worse off — a support burden and a trust cost in
exchange for nothing. The three alternatives:

- **Ship it anyway and accept the dead end.** Rejected on the above.
- **Gate the entry point on a config flag.** The client is static and there is no
  endpoint that serves configuration to it; inventing one so a button can be
  hidden is a new API surface for a flag.
- **Ship the screens without the entry point**, reachable only by a URL nobody
  has. Dead code in production, and the anchor F-018 would add is the one line
  this feature exists to justify.

The dependency is recorded in the yaml rather than as a sentence in this rollout
section for the reason F-025's entry gives: **the shipping order survives the
planning PR only if it is in the field the orchestrator reads.** It is an ordering
dependency, not a technical one — nothing in this design imports anything F-018
builds, and the two PRs could be written in either order. If you would rather have
the screens on staging first and accept the dead end in production for a while,
delete `F-018` from the deps line and nothing else in this spec changes except
this section and the first rollout step.

**No new backlog entry is created by this plan.** The email-verification screen
that would use the same mechanism is deliberately not given an id here — F-005's
verification is advisory (ADR 0011) and nothing is gated on it, so a screen for it
is a requirement nobody has stated.

## Acceptance criteria

- [ ] The signed-out panel shows a "Forgot your password?" control that opens the
      request screen, and "Back to sign in" returns to the sign-in form —
      `e2e: the signed-out panel leads to the reset request screen and back`
- [ ] `#reset=<43 valid characters>` shows the reset screen, and
      `location.href` no longer contains the token by the time the form is
      visible — `e2e: a reset link is refused without the token reaching a URL`
- [ ] **No request URL made by the page ever contains the token**, and exactly one
      request carries it — a `POST` to `/api/auth/password-reset/confirm` with the
      token in the body — asserted over every request the page makes via
      `page.on('request')` — `e2e: a reset link is refused without the token reaching a URL`
      plus `unit: the confirm call puts the token in the body and not the path`
- [ ] Clicking "Set new password" twice in quick succession produces exactly one
      confirm request — `e2e: a reset link is refused without the token reaching a URL`
- [ ] A `400 invalid_token` shows the API's message and reveals "Request a new
      link", which opens the request screen —
      `e2e: a reset link is refused without the token reaching a URL`
- [ ] `#reset=` carrying a 42-character, 44-character, or `+`/`/`-containing token
      shows the request screen with the "not complete" message and makes **no**
      HTTP request at all — `e2e: a malformed reset link sends no request` plus
      `unit: a malformed fragment is rejected without a call`
- [ ] The fragment parser accepts exactly `^[A-Za-z0-9_-]{43}$` after `#reset=`,
      returns "absent" for an empty hash, `#`, `#reset`, `#other=x`, and does not
      confuse `#reset=<43>&x=1` for a valid token —
      `unit: the reset fragment parser`
- [ ] Submitting the request screen posts `{ email }` to
      `/api/auth/password-reset` and renders one module constant, identical for a
      `202` on a known and an unknown address — asserted as the same constant, not
      as two equal renderings — `unit: the request screen shows one confirmation`
- [ ] The server's two `202` responses are byte-identical for a known and an
      unknown address — already green, must stay green:
      `integration: an unknown address is indistinguishable from a known one`
- [ ] A `204` from the confirm call resolves to the signed-out state carrying the
      "signed out everywhere" message, and never to a signed-in state —
      `unit: a confirmed reset returns the page to the sign-in form`
- [ ] `invalid_token`, `token_expired` and the client-side malformed case each
      produce a **distinct** message, and the first two set the "offer a new link"
      flag while `validation_failed` and `429` do not —
      `unit: every reset failure maps to its own message`
- [ ] A `429` shows the API's message verbatim and a `500` shows the generic
      message plus the `requestId`, on both screens —
      `unit: every reset failure maps to its own message`
- [ ] The token is never written to `localStorage`, `sessionStorage` or
      `document.cookie` — asserted in the browser after a reset screen has been
      opened — `e2e: a reset link is refused without the token reaching a URL`
- [ ] No file under `web/` contains an HTML-injection sink and `index.html` has no
      inline script or style — the existing
      `unit: the web client contains no HTML-injection sinks` scan covers both new
      files with no change to it
- [ ] Every element id passed to `byId()` in the two new modules exists in
      `web/index.html` — the existing
      `unit: the web client binds only to ids that exist` scan, unchanged
- [ ] The reset journey produces no console errors and no CSP violation beyond
      F-006's documented Cloudflare allowance —
      `e2e: a reset link is refused without the token reaching a URL`
- [ ] Every control on both screens is reachable and operable by keyboard, and
      every e2e selector is by role or label — enforced by the specs using
      `getByRole` / `getByLabel` exclusively
- [ ] `openapi.json` is unchanged and `npm run openapi:check` passes without
      touching it — CI Tier 1
- [ ] `du -sk dist` stays under the existing 2048 KiB CI budget — CI Tier 1

## Test plan

| Layer       | Cases                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unit        | **`tests/unit/password-reset-client.test.ts`**, node env, stubbed `fetch`, the shape of `todos-client.test.ts`. The fragment parser (valid, 42, 44, `+`, `/`, empty, `#`, `#reset`, `#other=x`, `#reset=<43>&x=1`, and a token that is valid but for trailing whitespace) · the request call (path, method, `{ email }` body, one confirmation constant for `202`, no email in the path) · the confirm call (`{ token, password }` in the body, token absent from the path and from any query string, `204` → the signed-out success resolution) · the failure mapping table, one case per row, asserting message **and** the offer-a-new-link flag · a malformed fragment makes no call at all (assert `fetch` was never invoked)                                                                        |
| integration | **No new cases, deliberately.** This feature adds no server code, and every contract it depends on already has a test in `tests/integration/password-reset.test.ts`: `issues a token for a known address`, `an unknown address is indistinguishable from a known one`, `consumes a token and sets the new password`, `a token cannot be used twice`, `an expired token is rejected with its own code`, `a reset does not sign the user in`, `rejects malformed input without truncating the error body`, and `the reset request endpoint has its own tighter limit`. F-016's precedent was to add integration cases pinning contracts the client newly depends on; here there are none that are not already pinned. The one thing to verify in review is that none of those eight is weakened by this PR. |
| e2e         | **`e2e/web-password-reset.spec.ts`**, Chromium, three specs, **none of which submits the request form** (see "Why the happy path has no e2e"): **the signed-out panel leads to the reset request screen and back** · **a reset link is refused without the token reaching a URL** (goto `/#reset=<43 syntactically valid characters>`, assert the scrub, assert the form, double-click submit, assert one confirm request, assert the token is in no request URL and in exactly one request body, assert the `invalid_token` message and the revealed button, assert empty `localStorage`/`sessionStorage`/`document.cookie` of the token, assert no console errors) · **a malformed reset link sends no request** (goto `/#reset=short`, assert the message and zero requests to the API)                |
| load        | **No new k6 scenario.** Nothing new is served: the page, the CSS and the modules are the same three static assets `load/smoke.js` already exercises, and both endpoints are once-per-user-per-year paths that F-004 already argued out of the load suite. What this feature changes is that `POST /api/auth/password-reset` starts receiving human traffic at all, which the rollout watch list below covers with metrics that already exist.                                                                                                                                                                                                                                                                                                                                                             |

## Security considerations

**The token in the page URL is the whole threat model**, and the four exposures it
creates are addressed in order:

- **Server logs and proxies.** A fragment is not in the request line. It cannot
  reach `http_request_duration_seconds`' route label, an access log, a proxy log
  or an APM trace, because it is never transmitted. This is the property a query
  string cannot be given, and it is why ADR 0028 exists.
- **`Referer`.** Browsers strip the fragment from `Referer` unconditionally, and
  the page loads nothing cross-origin anyway: the CSP is `default-src 'self'`,
  there is no font, no analytics, no icon set and no CDN. The residual is the one
  F-006 documented — Cloudflare fronts `*.sevalla.app` and injects its own script,
  which our CSP blocks. It is same-origin and therefore _could_ read a fragment if
  it ever executed; it does not execute, the e2e counts the violation rather than
  ignoring it, and this is the concrete reason ADR 0028 says the decision must be
  revisited the day any third-party script is added to this page.
- **History, bookmarks, screenshots, profile sync.** `history.replaceState` runs
  before the screen renders, so the entry that survives is `/`. What cannot be
  scrubbed is the moment between navigation and the module running, and the copy
  of the URL in the mail message itself — neither is addressable in a browser, and
  the token is single-use and lives 30 minutes.
- **A live credential in the DOM's reach.** For the life of that page the token is
  a JavaScript variable. The defences are exactly F-006's three: no HTML-injection
  sink anywhere under `web/` (unit-scanned, both new files covered), user data
  reaching the page only as text nodes, and a CSP with no `unsafe-inline` or
  `unsafe-eval`. An XSS on this page would be a full account takeover for whoever
  opened the link — which is true of the sign-in form's password field too, and is
  why those three defences are acceptance criteria rather than habits.

**Link scanners and prefetchers cannot burn a token.** Consumption requires a
`POST` with a password. A gateway that fetches every URL in a message, a browser
prerender and a chat client's link preview all load a page and change nothing.
Under ADR 0009 — one live token per account, and requesting a new one kills the
old — a token burned by a scanner would look to the user exactly like a bug in
this application.

**No new enumeration surface.** The request screen renders one constant on any
non-failure outcome and cannot distinguish a known from an unknown address,
because F-004's `202` carries no body. The only way this screen could leak
existence is a timing difference, which is the server's problem and is addressed
in F-004 (token generation and hashing on both branches, the mail send off the
response path).

**Nothing is stored client-side.** No token, no email, no user id in
`localStorage`, `sessionStorage` or a readable cookie — F-006's rule, with an e2e
assertion here because this is the first screen that holds a credential worth
stealing.

**Rate limiting.** Both routes keep F-004's limits untouched, and this feature
deliberately does not ask for `PASSWORD_RESET_RATE_LIMIT_MAX` to be raised
anywhere. 5/hour per IP is tight for a shared NAT — an office where two people
forget their password in the same hour will see the second one throttled — and
that is a real cost of leaving it alone, accepted because the alternative is
loosening the feature's primary anti-abuse control to make a test suite
comfortable. The API's message is shown verbatim so the user is told to wait
rather than told nothing.

**CSRF.** Both calls are same-origin `POST`s from the page, covered by the Origin
allowlist F-006 made a boot requirement and by `SameSite=Lax`. Neither call needs
a session, so a cross-site forgery of either accomplishes nothing an attacker
could not do with `curl`.

**Session handling.** The confirm destroys every session for the account inside
F-004's transaction. The client's contribution is that it calls
`unmountTodoList()` and returns to the signed-out panel on `204`, so a browser
that held a session before the reset shows none of that account's data afterwards
— the same residue rule F-016 made an acceptance criterion for log out.

**Logging.** No server change, so no new log line. In the browser nothing is
logged at all — no token, no address, no `requestId` to the console — which is
F-006's and F-016's standing position and matters most here.

## Observability

No new metric and no new server code; what changes is that four existing series
start describing humans, and one of them becomes readable for the first time.

- **`password_reset_total{outcome="requested"}` versus `{outcome="consumed"}`.**
  F-004 predicted this ratio and could not use it: with no screens and no mail,
  `consumed` was structurally zero. After this feature _and_ F-018,
  `requested` climbing while `consumed` stays flat is the "mail is not arriving or
  links are expiring" alarm. Before F-018, `consumed` staying at zero is expected
  and proves nothing — worth stating so nobody reads it as a green light.
- **`password_reset_total{outcome="invalid"}`.** After this ships, this counts
  users clicking superseded links (ADR 0009's cost, now measurable), mail clients
  mangling URLs that the client-side shape check did not catch, and attacks. A
  step change right after the first mail campaign means the link format is wrong —
  most likely a mail client rewriting or truncating the fragment, which is the
  failure mode ADR 0028 is most exposed to.
- **`password_reset_total{outcome="expired"}`.** A rising share says
  `PASSWORD_RESET_TTL_MINUTES` (30) is too short for how long mail takes to
  arrive, which is a number a human can change without touching this feature.
- **`http_request_duration_seconds{route="/api/auth/password-reset",status="429"}`.**
  Before this feature a `429` here was a script. After it, it is a locked-out
  person being turned away by the feature meant to help them. This is the single
  most important series to watch on the day F-018 lands, because 5/hour per IP was
  chosen when no browser could reach the endpoint.
- **`mail_messages_total{kind="password_reset",transport}`** stays F-004's proof
  that the un-awaited send happened. `transport="drop"` in production is exactly
  why this feature's merge is ordered after F-018.
- **Deliberately no client-side telemetry.** There is no endpoint to receive it,
  and a browser error report from this screen would carry the one thing in the
  application that must never be transmitted anywhere but a `POST` body.

## Rollout

**No feature flag, no configuration, no migration, no environment change.** The
change is markup, CSS and two browser modules inside the image. Every endpoint is
byte-identical, `openapi.json` is unchanged, and there is nothing to set in
Sevalla, in `.env.example`, or in any workflow file — which also means this PR
touches no CODEOWNERS-protected path and needs no `needs-human` review on that
account.

**Order.**

1. **F-018 ships first.** That is the dependency this plan adds to
   `specs/features.yaml` and the reason for it is in "Backlog and shipping order":
   with `MAIL_TRANSPORT=drop` these screens promise mail that nobody sends. If a
   reviewer removes the dependency, this step becomes "merge, and accept that the
   request screen is a dead end in production until F-018".
2. Merge. Staging deploys, `deploy.yml` runs the full Playwright suite —
   including this feature's three specs — against `STAGING_URL` before the
   production promotion gate. None of the three submits the request form, so the
   gate cannot be tripped by `PASSWORD_RESET_RATE_LIMIT_MAX`.
3. Verify by hand on staging, once, with a real address: request a link, follow
   it, set a password, sign in. This is the journey CI deliberately does not
   prove; record it in the PR the way F-015's rollout records its large-account
   run.

**Rollback at 2am.** Redeploy the previous image. The API is untouched, nothing
was migrated, no token, session or user row is affected either way, and the UI
reverts to a sign-in form with no "Forgot your password?" link. Outstanding reset
links stop working as pages while the tokens themselves remain valid until they
expire, so a user mid-flow simply requests another once the rollback is reverted.
This is among the cheapest rollbacks in the backlog; if the screens are broken but
the API is fine, nothing about it is urgent.

**What to watch after deploying, in order:**

1. `password_reset_total{outcome="requested"}` — it should become non-zero for the
   first time. If it stays flat, the entry point is not reachable: the button is
   hidden, the panel switch is broken, or the client module failed to load.
2. `password_reset_total{outcome="consumed"}` against `requested`. A healthy ratio
   is most requests eventually consumed. Zero consumed with non-zero requested,
   once F-018 is live, means the link format is wrong — check that the mail
   composes `<APP_BASE_URL>/#reset=<token>` exactly, with the fragment last and
   nothing after the token.
3. `password_reset_total{outcome="invalid"}`. A high share against a low
   `consumed` is a mail client mangling the fragment; the shape check in the
   browser means the truly mangled ones never even reach the server, so a rise
   here is specifically "well-formed but wrong or superseded".
4. `429` on `route="/api/auth/password-reset"`. If real users are hitting 5/hour
   per IP, the number needs a human decision — raise `PASSWORD_RESET_RATE_LIMIT_MAX`
   deliberately, do not let it be discovered as flaky support tickets.
5. Console errors from the e2e on staging. A CSP violation count above F-006's
   documented Cloudflare allowance of one means something other than Cloudflare is
   being blocked on the page that now handles a credential.

**Follow-ups this creates:**

- **A screen for F-005's verification token**, if anyone ever states the
  requirement. Deliberately not added to the backlog (ADR 0011 gates nothing on
  verification), but ADR 0028's mechanism is ready for it.
- **#11 should be reopened.** Not blocking here — this feature has no migration —
  but the guard and the runner are still in conflict while the issue reads closed.
- **No contract migration is owed**, because no migration ships at all.

**Diff budget.** Estimated ~485 hand-written lines: `web/index.html` (~45),
`web/styles.css` (~8), `web/src/reset.ts` (~90), `web/src/reset-panel.ts` (~110),
`web/src/main.ts` (~30), unit tests (~120), e2e (~85 minus the helpers it reuses
from `web-auth.spec.ts`). Under the ~500 guidance, so no split. If it runs over,
cut the CSS first, the double-submit assertion second and the
`localStorage`/`sessionStorage` scan third — **never** the fragment-parser cases,
the "token is in no request URL" assertion or the failure-mapping table, which are
this feature's entire security argument.
