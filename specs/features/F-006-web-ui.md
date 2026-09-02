# F-006 · Web UI — app shell and auth screens

> Status is tracked in `specs/features.yaml`, not here.

## Problem

The application has no user interface at all. Everything it does is reachable
only by hand-crafting HTTP requests with a session cookie, so the only people who
can use it are people holding `openapi.json` and a terminal. A person who opens
the deployed site in a browser gets a JSON 404. There is also no browser-level
proof that the session cookie actually works the way F-002 assumed it would —
every test to date has driven the API with a client that is far more forgiving
about cookies than a real browser is.

**Split note.** The backlog line for F-006 was "auth screens and todo list". At
the planned level of detail that is roughly 900–1000 hand-written lines across
three test layers, well past the ~500-line guidance in `.agents/planner.md`. It
is split in two: this feature ships the delivery mechanism and the signed-out /
signed-in states, and **F-016** ships the todo list screen inside the shell this
one builds. Each is a coherent slice a human can review in one sitting.

## Scope

**In scope**

- Serving a built web client from the existing Fastify server, at the same origin
  as the API
- One HTML page with two states: signed out (sign-in and create-account forms)
  and signed in (the account's email plus a log-out button)
- A typed browser API client over `fetch` that speaks the existing error shape
- Session bootstrap on page load via `GET /api/auth/me`
- Register, log in, log out from the browser, with server errors surfaced to the
  user (bad credentials, email taken, validation, rate limited)
- Content-Security-Policy tightened for a real HTML page, and cache headers for
  the static assets
- A boot-time refusal to serve the client when `ALLOWED_ORIGINS` is empty, so the
  CSRF Origin check cannot be silently absent in an environment that has a
  browser client
- Browser end-to-end coverage of the register → reload → log out journey

**Out of scope**

- **The todo list screen — that is F-016.** After signing in, this feature shows
  the account email and a log-out button and nothing else. That placeholder panel
  is where F-016 renders the list.
- Any change to an existing API endpoint, request, or response. The UI is a
  client of the API exactly as it is today.
- Client-side routing, a history API, deep links, or a catch-all HTML fallback
- Any UI framework, bundler, CSS framework, design system, icon set, or web font
- Password reset (F-004) and email verification (F-005) screens. Neither API
  exists yet; the UI gains them when they do.
- Remember-me, "log out everywhere" (F-009), account settings, avatars
- Dark mode, i18n, offline support, service workers, PWA install
- Client-side error reporting or analytics of any kind
- Fixing the account-enumeration property of `409 email_taken` on register. It is
  pre-existing API behaviour from F-002; this feature displays it, and does not
  redesign it. See "Security considerations".

## Design

### API changes

No existing endpoint changes. Two new **public, non-JSON** routes:

| Method | Path     | Auth | Notes                                                                                                                 |
| ------ | -------- | ---- | --------------------------------------------------------------------------------------------------------------------- |
| GET    | `/`      | none | `text/html`, serves `<WEB_ROOT>/index.html`. `Cache-Control: no-cache`. Hidden from OpenAPI.                          |
| GET    | `/app/*` | none | Static assets (`main.js`, `api.js`, `dom.js`, `styles.css`) from `<WEB_ROOT>/app`. `Cache-Control: no-cache`. Hidden. |

Both are registered with `schema: { hide: true }`, like `/metrics`, so
`openapi.json` does not change and the `openapi:check` gate stays green without
touching a CODEOWNERS-protected file.

**No catch-all.** `/` is the only HTML route. Any other unmatched path — including
`/api/anything` and `/does-not-exist` — keeps today's JSON 404 from
`registerErrorHandler`. An SPA fallback would be the only way for an API path to
start returning HTML, and there is no client-side routing here that needs one.

The browser calls only existing endpoints:

| Call                      | Used for          | Handled failures                                           |
| ------------------------- | ----------------- | ---------------------------------------------------------- |
| `GET /api/auth/me`        | bootstrap on load | `401` → signed-out state (expected, not an error)          |
| `POST /api/auth/register` | create account    | `409 email_taken`, `400 validation_failed`, `429`          |
| `POST /api/auth/login`    | sign in           | `401 unauthorized`, `400 validation_failed`, `429`         |
| `POST /api/auth/logout`   | sign out          | any failure → still return to the signed-out state locally |

### Data model changes

**None.** No migration, no new table, no new column, no index, no backfill —
therefore no expand/contract plan to state. This feature adds no persistent state
of its own; the only state it touches is the session cookie F-002 already issues.

One new config key in `src/config.ts`:

```
WEB_ROOT  string  default "dist/public"   # directory holding the built client
```

`WEB_ROOT` is a required field on the `Config` type (defaulted, not optional), so
every construction site of a `Config` literal — today that is
`scripts/dump-openapi.ts` — fails typecheck until it is updated. That is
deliberate: it makes the boot rule below impossible to skip by accident.

The existing `ALLOWED_ORIGINS` key does not change shape, but it stops being
optional in practice. See "Boot behaviour" below.

### File layout

```
web/
  index.html            static markup for both panels; no inline script or style
  styles.css
  tsconfig.json         lib: ES2023 + DOM, outDir ../dist/public/app
  src/
    api.ts              fetch wrapper, error mapping.  MUST NOT touch the DOM.
    dom.ts              element helpers; textContent only, never innerHTML
    main.ts             bootstrap, panel switching, form handlers
src/routes/web.ts       the two routes above
scripts/build-web.mjs   copies index.html + styles.css into dist/public
tests/fixtures/web/     tiny index.html + app/ files for integration tests
```

Build: `npm run build` becomes
`tsc -p tsconfig.build.json && tsc -p web/tsconfig.json && node scripts/build-web.mjs`,
producing `dist/public/index.html` and `dist/public/app/*.{js,css}`. `tsc` emits
browser-loadable ESM directly (relative imports are already written with `.js`
extensions throughout this repo), so `<script type="module" src="/app/main.js">`
works with no bundler and no import map. The `Dockerfile` already copies `dist/`
wholesale, so **no `Dockerfile`, `docker-compose.yml`, or entrypoint change**.

This PR does, however, add one environment line to three CODEOWNERS-protected
workflow files, which puts it on the `needs-human` path. That is a direct and
intended consequence of the boot rule below; the sites are enumerated there.

`make dev` gains a `npm run build:web` step; iterating on the client is
`tsc -p web/tsconfig.json --watch` in a second terminal.

### Toolchain traps this design routes around

These are load-bearing; the implementer will hit all four.

1. **The root `tsconfig.json` has no DOM lib** (`lib: ["ES2023"]`, `types: ["node"]`)
   and its `include` does not cover `web/`. Hence a separate `web/tsconfig.json`.
   `npm run typecheck` becomes `tsc --noEmit && tsc --noEmit -p web/tsconfig.json`.
2. **ESLint needs no config change.** `projectService` resolves each file against
   its nearest `tsconfig.json`, so `web/**` is type-linted by `web/tsconfig.json`
   automatically, and `recommendedTypeChecked` already disables `no-undef` for TS,
   so `document`/`window` need no `globals` entry. `eslint.config.js` is a
   CODEOWNERS-protected quality gate — **do not edit it.**
3. **Integration tests run before any build** (`npx vitest run --project integration`
   in CI Tier 1, and again under `--coverage`). Registering a static root that does
   not exist would break every existing integration test. Hence `WEB_ROOT`, the
   fixture directory, and the boot behaviour below.
4. **`vitest.config.ts` and `vitest.workspace.ts` are protected.** No new vitest
   project, no environment change; unit tests here run in the existing `node`
   environment, which is why `api.ts` must stay DOM-free.

### Boot behaviour: two ways this refuses to start

`registerWebRoutes` decides at startup whether this process serves a browser
client, by checking for `<WEB_ROOT>/index.html`.

**Rule 1 — the client is not built.**

- present → serving; continue to rule 2
- missing and `NODE_ENV === 'production'` → **throw**, so the container never
  becomes ready and Sevalla keeps the previous revision
- missing otherwise → log a `warn` and register nothing; `GET /` stays a JSON 404

**Rule 2 — serving a client with no origin allowlist.**

When rule 1 says "serving" and `allowedOrigins(config)` is empty,
`registerWebRoutes` **throws** before registering anything:

```
ALLOWED_ORIGINS is empty while WEB_ROOT (<path>) is serving a browser client.
That disables the CSRF origin check. Set ALLOWED_ORIGINS to the site origin.
```

This applies in **every** `NODE_ENV` — no development exemption, no test
exemption, no "warn in dev, throw in prod". An environment-dependent security
default is the exact bug being closed here, so reintroducing one at a smaller
scale would defeat the change. `buildApp` rejects, `src/index.ts` exits non-zero,
`/readyz` is never served, and the previous revision stays up.

Rule 2 is keyed on _"is this process actually serving a browser client"_, not on
_"was `WEB_ROOT` typed into the environment"_. `WEB_ROOT` is defaulted to
`dist/public`, so the production image serves the client without anyone setting
the variable — a check keyed on the variable being present would therefore miss
the single most important case, which is the same silent-default failure it is
meant to prevent.

Together with rule 1 this mirrors `loadConfig`'s "die at boot rather than at
first request" stance: `loadConfig` already refuses a missing `DATABASE_URL`, a
short `COOKIE_SECRET`, and the example cookie secret in production. An origin
allowlist that is empty while a browser is being served belongs in that same
category — it is not a tuning knob, it is a missing security control.

The boot log line on the success path is `{ webRoot, assetCount, originCount }`,
so a running container proves the allowlist is non-empty without anyone needing
to read its environment.

**Sites that must now set `ALLOWED_ORIGINS`.** Rule 2 fires anywhere the client
is built and the app is then booted. Every such site is enumerated here; missing
one turns a whole CI job red, which is the intended loudness but should not be a
surprise in review.

| Site                                              | Change                                                                      |
| ------------------------------------------------- | --------------------------------------------------------------------------- |
| `.env.example`                                    | add `ALLOWED_ORIGINS=http://localhost:3000` (the key is absent today)       |
| `.github/workflows/e2e.yml` — `e2e` job `env:`    | add `ALLOWED_ORIGINS: http://127.0.0.1:3000` · **CODEOWNERS-protected**     |
| `.github/workflows/e2e.yml` — `load` job `env:`   | same · **CODEOWNERS-protected**                                             |
| `.github/workflows/nightly.yml` — soak job `env:` | same · **CODEOWNERS-protected**, and this job runs `NODE_ENV=production`    |
| `scripts/dump-openapi.ts`                         | add `WEB_ROOT` to its `Config` literal, pointing at a path with no client   |
| `tests/integration/helpers.ts`                    | default `WEB_ROOT` to a path that does not exist (below)                    |
| Sevalla staging and production                    | `ALLOWED_ORIGINS=<site origin>`, set **before** this merges (see "Rollout") |

The three workflow files are the reason this PR needs a human on a protected
path. `playwright.config.ts` is protected too, but needs no change: its
`webServer` inherits the job environment.

**Why the integration helper pins `WEB_ROOT` to a nonexistent path.** CI Tier 1
runs `npm run build` _after_ the integration suite, so `dist/public` does not
exist there — but a developer who runs the suite after a local build would
otherwise hit rule 2 and see every integration test fail for reasons unrelated to
what they changed. `createTestContext` therefore sets `WEB_ROOT` to a directory
with no client in its defaults, and the web tests opt in by overriding it with
the fixture. Boot behaviour under test is then chosen by the test, never
inherited from whether someone happened to build.

### Client behaviour

**Bootstrap.** On `DOMContentLoaded`, `GET /api/auth/me`. `200` → signed-in panel
with the email; `401` → signed-out panel (this is the expected path for a first
visit and must not surface an error); anything else → signed-out panel plus a
"cannot reach the server" message.

**API client (`web/src/api.ts`).** One function, `apiFetch<T>(path, init)`:

- `credentials: 'same-origin'` (the default, stated explicitly), `accept: application/json`,
  `content-type: application/json` when there is a body
- `signal: AbortSignal.timeout(10_000)` — AGENTS.md's "anything that can hang gets
  a timeout" applies in the browser too
- `204` → `undefined`; other `2xx` → parsed JSON
- non-2xx → throws `ApiFailure { status, code, message, requestId }` parsed from
  `{ error: { code, message }, requestId }`
- a non-2xx whose body is not that shape (a proxy's HTML 502, a truncated
  response) → `ApiFailure` with `code: 'unknown'` and a generic message, never a
  raw parse error and never the raw body
- it imports nothing, references no DOM type, and touches no global other than
  `fetch`/`AbortSignal`, so `tests/unit/` can import it under the node tsconfig

**Rendering.** `dom.ts` exposes small `el()`/`text()` helpers built on
`document.createElement` and `textContent`. **`innerHTML`, `insertAdjacentHTML`,
`document.write`, and `eval` appear nowhere in `web/`** — enforced by a unit test
that scans the sources, and by a CSP with no `unsafe-inline`.

**State.** Held in module-scope variables only. **Nothing is written to
`localStorage`, `sessionStorage`, or a non-HttpOnly cookie** — no token, no email,
no user id. The session stays exactly where F-002 put it: an HttpOnly cookie the
client cannot read.

**Forms.** Sign-in and create-account are two forms in the markup; one is visible
at a time, toggled by a button. Both have `type="email" required` and
`minlength="12" maxlength="200"` on the password, mirroring the server's
`Credentials` schema without pretending to be the authority. Submit disables the
button until the request settles, which is also the double-submit guard.

**Errors.** One `role="alert" aria-live="polite"` region per panel. `4xx` shows
`error.message` from the API verbatim (the messages are already user-facing:
"Invalid email or password", "An account with that email already exists",
"Too many requests. Retry in 30 seconds."). `5xx` shows a fixed
"Something went wrong. Please try again." plus the `requestId`, so a user can
quote it in a bug report. Focus moves to the alert region on failure.

**Accessibility.** `<html lang="en">`, viewport meta, one `<h1>`, a `<label for>`
on every input, keyboard-operable everywhere, visible focus styles. E2E specs
select by label and role, which makes the a11y contract a test rather than a
comment.

### Security headers

The helmet CSP in `src/app.ts` becomes explicit rather than relying on the
`default-src` fallback:

```
default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:;
connect-src 'self'; base-uri 'none'; form-action 'self'; object-src 'none';
frame-ancestors 'none'
```

No `unsafe-inline`, no `unsafe-eval`, anywhere. This is a strict tightening of
what is there today, and it is what makes the "no inline script, no `innerHTML`"
rule enforceable rather than aspirational.

### Key decisions

See **`docs/adr/0006-server-served-web-client.md`** for the full argument on the
first two, and **`docs/adr/0007-fail-closed-security-config.md`** for the boot
rule. Summary:

**Served by the existing Fastify process at the same origin.** Rejected: a
separate static host or CDN origin. A different origin means the session cookie
becomes cross-site, which forces `SameSite=None; Secure` and full CORS with
credentials — dismantling exactly the CSRF posture ADR 0004 relies on — and adds
a second deploy target for a three-file client.

**No UI framework and no bundler; TypeScript compiled to browser ESM by the `tsc`
that is already here.** Rejected: React + Vite (100+ packages into a
CODEOWNERS-reviewed `package-lock.json`, a second build pipeline, a second lint
plugin, and a bundle that eats ~10% of CI's 2048 KiB `dist` budget, to render two
forms); Preact/htm (smaller, still a runtime dependency and a template-literal
parser); server-rendered HTML forms with progressive enhancement (would need
HTML-flavoured `POST /login` handlers duplicating `src/routes/auth.ts`, a
CODEOWNERS-protected file, and would fork the error shape into a second
representation). The cost of this choice is hand-written DOM code; the mitigations
are the source scan, the CSP, and a real-browser e2e suite.

**One page, two panels, no client-side router.** Rejected: history-API routing,
which requires a catch-all HTML fallback — the one construct that can make an API
path return HTML. There are exactly two states here; a router would be
extensibility for a need nobody has stated.

**`Cache-Control: no-cache` + ETag on every asset.** Rejected: `immutable` with
content-hashed filenames, which needs a bundler. Filenames are stable, so a stale
cached `main.js` against a newer API is the failure mode to avoid; revalidation
costs one conditional request per asset per load and returns `304`.

**Static routes are exempt from the rate limit** (`config: { rateLimit: false }`,
the same treatment `/healthz` gets). A page load is three requests; an office
behind one NAT would otherwise burn the 100/min budget on CSS and see the whole
app fail. These routes read a file and touch no database. The auth endpoints keep
their own tighter `AUTH_RATE_LIMIT_MAX`, which is what actually matters here.

**Serving the client without an origin allowlist is a boot failure, not a
warning.** `ALLOWED_ORIGINS` defaults to empty and an empty value disables the
CSRF origin check entirely, so shipping a browser client against that default
would remove a security layer with no signal anywhere. Rejected alternatives:

- _A line in the runbook and the issue body ("set `ALLOWED_ORIGINS` on staging
  and production")._ This was the previous revision of this spec. A default that
  is silently wrong until the day it matters is precisely the failure class this
  project has already paid for; "remember to set it" is not a control.
- _Warn at boot instead of throwing._ A warning in a log nobody reads is the same
  outcome with more text. The whole value is that the deploy stops.
- _Throw only when `NODE_ENV === 'production'`._ Cheaper for CI, but it makes the
  security posture differ by environment, so the check would never actually run
  before the deploy that needs it. Same objection as the runbook line.
- _Put the check in `loadConfig` keyed on `WEB_ROOT` being set in the
  environment._ This is where the closest existing checks live and it is the
  first thing to look for in review, so the deviation is deliberate: `WEB_ROOT`
  is defaulted, so the production image serves the client with the variable
  unset, and a pure-environment check would pass exactly when it matters most.
  `loadConfig` is pure over `process.env` and unit-tested with plain objects;
  making it stat the filesystem to find out would be worse than putting the
  check next to the filesystem check that already exists.
- _Make the origin check fail closed instead — when the allowlist is empty,
  validate `Origin` against the request's own `Host`._ This needs no
  configuration at all and is the strongest competitor. Rejected as out of scope:
  it changes the behaviour of every existing state-changing endpoint, it trusts a
  proxy-supplied header, and it revisits ADR 0004. If it is ever wanted, it is
  its own feature with its own ADR, not a rider on the UI.

**`WEB_ROOT` config plus a test fixture directory** rather than building the
client inside the integration `globalSetup`. It keeps `src/routes/web.ts` — the
part that counts toward the coverage gate — testable hermetically and fast, and
leaves "the real page loads" to the e2e layer, where a real browser proves it.

## Acceptance criteria

- [ ] `GET /` returns `200`, `content-type: text/html`, and the shell markup —
      `integration: serves the app shell at /`
- [ ] `GET /app/main.js` returns `200` with a JavaScript content type and
      `Cache-Control: no-cache`; `GET /app/styles.css` returns `200` with
      `text/css` — `integration: serves static assets with revalidation headers`
- [ ] `GET /app/../../package.json` and its percent-encoded form return `404` and
      no file contents — `integration: refuses path traversal`
- [ ] `GET /app/missing.js` returns `404` with the standard
      `{ error: { code, message }, requestId }` body —
      `integration: unknown asset returns the JSON error shape`
- [ ] `GET /does-not-exist` and `GET /api/does-not-exist` still return the JSON
      `404` — `integration: no HTML fallback shadows the API`
- [ ] `GET /` carries a CSP containing `script-src 'self'` and no `unsafe-inline`
      or `unsafe-eval` — `integration: serves a strict content security policy`
- [ ] Neither new route appears in the generated OpenAPI document, and
      `npm run openapi:check` passes with `openapi.json` unchanged —
      `integration: web routes are hidden from the API contract`
- [ ] `/metrics` reports the asset route under a single `route="/app/*"` label
      after two different files are fetched, not one series per file —
      `integration: asset metrics have bounded cardinality`
- [ ] With `WEB_ROOT` pointing at a directory with no `index.html`, `buildApp`
      rejects when `NODE_ENV=production` and boots without the routes otherwise —
      `integration: refuses to boot in production without a built client`
- [ ] With `WEB_ROOT` pointing at the fixture client and `ALLOWED_ORIGINS` empty,
      `buildApp` rejects with an error naming `ALLOWED_ORIGINS`, and does so for
      `NODE_ENV` of `development`, `test`, and `production` alike —
      `integration: refuses to boot when serving the client without an origin allowlist`
- [ ] With `WEB_ROOT` pointing at a directory with no `index.html` and
      `ALLOWED_ORIGINS` empty, `buildApp` still resolves outside production —
      the allowlist is required only when a client is actually served —
      `integration: an unbuilt client does not require an origin allowlist`
- [ ] With the fixture client and `ALLOWED_ORIGINS` set, `buildApp` resolves and
      `GET /` returns `200` — proves the check is conditional, not a
      throw-always — `integration: boots and serves when the origin allowlist is set`
- [ ] In an app instance that is serving the client, `POST /api/auth/login` with
      an `Origin` header of `https://evil.example` is rejected `403` while the
      same request with an allowed `Origin` reaches the handler — the origin
      check is provably active, which is the thing the boot rule exists to
      guarantee — `integration: cross-origin state changes are rejected when the client is served`
- [ ] The boot log line emitted on the serving path carries a non-zero
      `originCount` alongside `webRoot` and `assetCount` —
      `integration: the boot log proves the allowlist is populated`
- [ ] `apiFetch` maps a non-2xx JSON error body to `ApiFailure` carrying `status`,
      `code`, `message`, and `requestId`; maps a `204` to `undefined`; and maps a
      non-JSON error body to `code: 'unknown'` without leaking the body —
      `unit: apiFetch error mapping`
- [ ] No file under `web/` contains `innerHTML`, `insertAdjacentHTML`,
      `document.write`, or `eval`, and `web/index.html` contains no inline
      `<script>` or `<style>` and references only `/app/` assets —
      `unit: the web client contains no HTML-injection sinks`
- [ ] In a real browser, a visitor at `/` sees the sign-in form; creating an
      account with a fresh email shows their email and a log-out button; reloading
      the page keeps them signed in; logging out returns the sign-in form and a
      reload stays signed out — `e2e: register, persist across reload, log out`
- [ ] Signing in with a wrong password shows "Invalid email or password" and the
      user stays signed out — `e2e: rejected credentials are shown to the user`
- [ ] Registering an email that already exists shows the API's `email_taken`
      message — `e2e: duplicate registration is shown to the user`
- [ ] The whole browser journey produces no console errors and no CSP violation
      reports — `e2e: the page loads with no console errors` (this is the test
      that catches a CSP that blocks the app's own script)
- [ ] `du -sk dist` stays under the existing 2048 KiB CI budget — CI Tier 1
      already enforces it

## Test plan

| Layer       | Cases                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unit        | `apiFetch`: 2xx JSON, `204` → `undefined`, error-shape mapping, non-JSON error body, network rejection, timeout signal wiring (all with a stubbed `fetch`, node environment, no jsdom) · source scan for HTML-injection sinks and for inline script/style in `index.html`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| integration | happy path (`/` and both assets) · validation failure (traversal, unknown asset → JSON 404 shape) · unauthenticated (both routes are public **by design** and must return `200` with no session — asserted, and asserted to set no cookie) · other user's resource (n/a: these routes serve no user data — asserted by their absence of any `userId` in the handler, covered instead by the CSP and no-fallback cases) · CSP header · OpenAPI hiding · metrics cardinality · boot failure with a missing client · **boot failure when serving the client with an empty `ALLOWED_ORIGINS`, asserted in all three `NODE_ENV` values, plus the two negative cases (unbuilt client boots; configured allowlist boots and serves) and the cross-origin `403` that proves the check is live** |
| e2e         | `e2e/web-auth.spec.ts` in Chromium: register → reload → log out → reload · wrong password · duplicate email · zero console errors across the journey. Selectors are label- and role-based, so the a11y contract is under test.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| load        | No new k6 scenario. These routes read a file from the OS page cache and issue no query; adding a scenario would measure `send`, not this application. `http_request_duration_seconds{route="/"}` already measures real page loads in production, which is the number that matters.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

The "other user's resource" column is normally the most important row in this
repo. It does not apply here because neither new route reads user-scoped data —
which is itself the thing to verify in review: if a later revision of this feature
starts templating user data into `index.html`, that exemption is void.

## Security considerations

**Cross-site scripting.** This is the feature's main new attack surface. Three
independent layers: user-controlled data reaches the page only as text nodes
(`textContent`); no HTML-injection sink exists in `web/` (unit-tested); and the
CSP forbids inline and `eval`'d script so an injected string is inert even if the
first two fail. Semgrep's `p/owasp-top-ten` in the Tier 2 job flags these sinks
too.

**Session token exposure.** The client never reads, stores, or transmits the
session token. It stays an HttpOnly, signed, `SameSite=Lax` cookie set by F-002.
No token or profile data touches `localStorage`, so an XSS that somehow lands has
nothing durable to exfiltrate and cannot outlive the tab.

**CSRF.** Same-origin `fetch` plus `SameSite=Lax` plus the existing Origin check
on state-changing methods. `form-action 'self'` blocks a native form post to
another origin.

`ALLOWED_ORIGINS` is empty by default, and `src/app.ts` registers the Origin hook
only when the allowlist is non-empty — so the default silently disables that
layer. Before a UI existed this was a latent gap; shipping a browser client
against it would be shipping a cookie-authenticated app with one of its three
CSRF layers switched off and nothing anywhere saying so.

**This feature therefore makes a populated allowlist a precondition for serving
the client, enforced at boot.** If `<WEB_ROOT>/index.html` exists and
`allowedOrigins(config)` is empty, `registerWebRoutes` throws, `buildApp`
rejects, and the process exits non-zero — in every `NODE_ENV`, with no exemption
for development or test. The container never reports ready, so a deploy missing
the variable rolls forward into nothing rather than into a weakened app. See
"Boot behaviour" for the rule and "Key decisions" for the alternatives rejected,
including the previous revision's approach of leaving it to a runbook line.

The boot rule guarantees the check is _configured_; the integration test
asserting a `403` on a foreign `Origin` in a client-serving instance guarantees
it is _effective_. Both are acceptance criteria, because a boot check that
passes while the hook is misregistered would be worse than no check at all.

**Path traversal and file disclosure.** Assets are served from a single root with
`index: false` and `dotfiles: 'deny'`; traversal is tested with both raw and
percent-encoded `..`. `WEB_ROOT` is server-side configuration, never derived from
a request.

**Clickjacking.** `frame-ancestors 'none'`, already present, now explicit.

**Account enumeration.** `POST /api/auth/register` returns `409 email_taken`,
which lets anyone test whether an address has an account; the login path is
already timing-equalised against this, register is not. The UI does not create
this — it makes it convenient. Not fixed here (that is an API-behaviour change
belonging with F-004/F-005), but the human should know that shipping a UI raises
the practical value of that leak. The `AUTH_RATE_LIMIT_MAX` of 10/min is the only
thing currently limiting it.

**Denial of service.** Static routes are exempt from the rate limit, so they can
be hammered for free — the same trade already made for `/healthz`. They serve at
most four small files from a fixed directory, with no database access and no
allocation proportional to the request, and `under-pressure` still sheds load if
the event loop backs up.

**Logging.** No new server-side logging beyond one boot line (`webRoot`,
`assetCount`). No email address, cookie, or request body is logged — the existing
redaction rules cover the new routes automatically. In the browser, nothing is
logged: no response bodies, no email addresses, no request ids to the console.

## Observability

- `http_request_duration_seconds{route="/",status="200"}` — page-load rate and
  latency. A drop to zero after a deploy means the assets did not ship; the boot
  check should have caught it first, and if it did not, this is the second signal.
- `http_request_duration_seconds{route="/app/*"}` — one series for all assets, not
  one per file. Cardinality is asserted in an integration test because a wildcard
  route mislabelled with the raw URL would quietly multiply every metric series.
  A rising `status="304"` share is the caching working as designed.
- The ratio of `401` to `200` on `route="/api/auth/me"` becomes the "how many
  visitors are signed out" signal, and a sudden jump in `401` right after a deploy
  is the fastest indication that sessions broke.
- `429` appearing on `/api/auth/login` or `/api/auth/register` now means a human
  is being blocked by a form, not a script being throttled. Worth watching for a
  day after launch: `AUTH_RATE_LIMIT_MAX` was set with no UI in existence.
- One structured boot log line, `{ webRoot, assetCount, originCount }`, proves
  the running container actually contains the client and that the CSRF origin
  allowlist is populated. `originCount` is there so the answer to "is the origin
  check on in production right now" is a log query rather than someone reading
  the deploy environment; by the boot rule it can never be `0` on this line, so
  its absence from the logs means the client is not being served at all.
- Deliberately **no client-side telemetry.** There is no endpoint to receive it,
  and error reports from a browser routinely carry PII in URLs and form state.

## Rollout

**No feature flag.** The feature is two new routes plus files inside the image;
every existing endpoint is byte-identical. A flag would gate a page that simply
does not exist in the previous revision.

**Order.** One PR, no migration, no backfill, no ordering constraint against any
other feature. Merge to `main` deploys to staging, where `deploy.yml` runs the
full Playwright suite — including this feature's browser specs — against
`STAGING_URL` before the production promotion gate. That makes the staging smoke
test a real gate for this feature rather than a formality.

**Environment — do this first.** Set `ALLOWED_ORIGINS` to the site origin on
staging **and** production **before merging this PR**. It is no longer optional
hardening: the app refuses to boot with a built client and an empty allowlist, so
a merge that lands ahead of the environment change fails the staging deploy at
container start. That is the designed behaviour and it is safe — the previous
revision keeps serving — but it is an avoidable red deploy.

Order:

1. Set `ALLOWED_ORIGINS` on staging and production in Sevalla.
2. Merge the three CODEOWNERS-protected workflow env lines and the rest of the PR
   together; the `e2e`, `load`, and nightly soak jobs all boot a built client and
   go red without them.
3. Merge → staging deploy → `deploy.yml` runs Playwright against `STAGING_URL`,
   which now also exercises the origin check end to end.

`WEB_ROOT` stays optional; the default is correct for the image.

**Rollback at 2am.** Redeploy the previous image; it has no `/` route and the API
is untouched, so any API client is unaffected either way. There is no runtime off
switch by design — pointing `WEB_ROOT` at an empty directory in production makes
the container refuse to boot rather than disabling the UI, which is the intended
behaviour, not a lever. If the UI is broken but the API is fine, the correct move
is a rollback, and nothing about it is urgent.

**Diff budget.** Estimated ~515 hand-written lines: `web/` (~230 including
`index.html` and CSS), `src/routes/web.ts` (~65 — the boot rule is ~10 of them),
`src/app.ts`/`src/config.ts` (~25), build script and `package.json`/`Makefile`
wiring (~40), fixtures (~15), tests (~205 across three layers), ~6 lines of
environment across `.env.example`, three workflow files, `dump-openapi.ts` and
the integration helper, plus a `Web` row in the AGENTS.md stack table. The
boot-rule amendment added roughly 35 of these; it is over the ~500 guidance by
about 3%, which is not worth a second split — the extra lines are one guard
clause and its tests, all in files this PR already touches.
If it runs over, cut CSS polish first and the create-account/sign-in toggle
animation second — never a test. `package-lock.json` gains exactly one production
dependency, `@fastify/static` (^8, the Fastify org's own plugin, required for
correct content types, ETag/304 handling, and range requests); justify it in the
PR body as AGENTS.md requires. No dev dependency is added: keeping `api.ts`
DOM-free is what avoids needing `jsdom`.
