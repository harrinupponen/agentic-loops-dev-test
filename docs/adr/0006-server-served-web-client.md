# 6. A same-origin web client with no framework and no bundler

Date: 2026-09-02
Status: Accepted

## Context

The application has been headless since F-001. F-006 adds a browser UI, which
means choosing a frontend stack from nothing. Two questions have to be answered
together, because the second constrains the first: **where is the client served
from**, and **what builds it**.

The constraints are unusually specific here, and they are what decide it:

- Authentication is an opaque session in a signed, HttpOnly, `SameSite=Lax`
  cookie, with CSRF defended by `SameSite` plus an Origin allowlist (ADR 0004).
  That posture assumes the client and the API share an origin.
- `package-lock.json` is CODEOWNERS-protected and every change triggers human
  review. AGENTS.md: "never add a dependency casually."
- CI Tier 1 enforces a 2048 KiB budget on `dist/`, which is 132 KiB today.
- `vitest.config.ts`, `vitest.workspace.ts`, `eslint.config.js`,
  `playwright.config.ts`, and `.github/` are quality gates agents must not edit.
- The product is two forms and a list. It is small on purpose; the discipline
  around it is the point.

## Decision

**Same origin.** The built client is served by the existing Fastify process from
`dist/public`: `GET /` returns the page, `GET /app/*` returns the assets. No
second origin, no CDN, no separate deploy target.

**No UI framework and no bundler.** The client is TypeScript in `web/src/`,
compiled to browser-native ESM by the `tsc` already in the repo, loaded with
`<script type="module">`. It has zero runtime dependencies. One production
dependency is added to the server, `@fastify/static`, for content types, ETag
revalidation, and traversal-safe file resolution.

The client is one HTML page with two panels and no client-side router, so there
is no catch-all HTML fallback that could shadow an API route. Assets are served
with `Cache-Control: no-cache` and revalidated by ETag, because without a bundler
there are no content-hashed filenames.

## Alternatives rejected

**A separate static origin or CDN.** Cross-origin cookies would force
`SameSite=None; Secure` and CORS with credentials, which discards the CSRF
defence ADR 0004 depends on and replaces it with a token scheme nobody asked for.
It also doubles the deploy surface for four files. If a CDN is ever wanted, it
belongs in front of this origin, not beside it.

**React + Vite.** The honest default for a large UI, and the wrong tool for two
forms. It brings 100+ transitive packages through a human-reviewed lock file, a
second build pipeline, a second lint plugin to make hooks safe, a jsdom plus
Testing Library stack to make components testable, and a bundle consuming roughly
a tenth of the CI size budget. Every one of those costs recurs on every future
PR, in exchange for reactivity this UI does not have enough state to need.

**Preact, lit, or htm.** Smaller, and genuinely tempting. Still a runtime
dependency, still a template-literal parser to reason about under a strict CSP,
and still a framework's worth of behaviour to hold in your head — for a page that
toggles between two panels.

**Server-rendered HTML forms with progressive enhancement.** No JavaScript at
all, which is attractive. It requires HTML-flavoured `POST /login` and
`POST /register` handlers that duplicate the logic in `src/routes/auth.ts` — a
CODEOWNERS-protected, security-critical file — and forks the error contract into
a second representation that has to be kept in step with the JSON one forever.
The JSON API already exists and is already tested; the UI should be a client of
it, not a parallel implementation.

**Content-hashed filenames with long-lived immutable caching.** Requires a
bundler, which is the decision above. Revalidation is one conditional request per
asset per page load, returning `304`. At this size that is not worth a build tool.

## Consequences

The client is hand-written DOM code, which is the real price. Hand-written DOM
code is where XSS lives, so three defences are mandatory rather than encouraged:
data reaches the page only through `textContent`, a unit test fails the build if
`innerHTML`, `insertAdjacentHTML`, `document.write`, or `eval` appears anywhere
under `web/`, and the CSP carries no `unsafe-inline` or `unsafe-eval`.

There is no hot module reload. Iterating on the client is `tsc --watch` and a
browser refresh.

The API client module must stay free of DOM references so the existing
node-environment unit project can import it. Everything that touches the DOM is
verified in a real browser by Playwright, which is a stronger guarantee than jsdom
and costs no new dependency.

This decision holds while the UI stays small. The signal to revisit it is
duplicated rendering logic and manual state synchronisation appearing across
several screens — not screen count on its own. Revisiting means a new ADR that
supersedes this one, and the same-origin half of this decision should survive it
regardless of what renders the page.
