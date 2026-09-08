# 13. Server spans are ours; auto-instrumentation only for Postgres

Date: 2026-09-08
Status: Accepted

## Context

The default way to instrument a Node service is
`@opentelemetry/auto-instrumentations-node` behind `--require`: it patches HTTP,
the framework, the database driver, and thirty other libraries, and spans appear
without application code. It is the right default for a service nobody has time to
instrument.

This repository is the opposite case. It has one HTTP framework, one database
driver, no outbound calls (`MAIL_TRANSPORT=drop`, ADR 0010), and a lockfile change
that triggers human review by rule. It also has an existing convention for exactly
this problem: `src/plugins/metrics.ts` labels its histogram with
`request.routeOptions.url` — the route _template_ — precisely so `/api/todos/:id`
is one label and not one per uuid.

Two properties of auto-instrumentation conflict with what the spec needs:

- `instrumentation-http` records `url.full` and `url.query` by default. Spans are
  the one signal in this system designed to be pushed outside the perimeter, and
  a query string is where a token eventually hides. Removing attributes an
  instrumentation added means writing a scrubbing span processor and trusting it
  to keep up with the library's next release.
- The app is ESM (`"type": "module"`, Node 22). OTel's patching needs a module
  hook registered before the application graph evaluates, which means a preload
  flag on the process — `import` statements are hoisted, so no call from inside
  `src/index.ts` is early enough. That flag is a change to `Dockerfile` and
  `scripts/docker-entrypoint.sh`, both CODEOWNERS-gated, and it is the one edit in
  the feature that can stop a container starting.

Meanwhile the value of tracing here is almost entirely in one place: which query,
in which handler, took the time. That needs `pg` spans, and `pg` spans are the one
thing that cannot reasonably be hand-written — Drizzle reaches the driver through
`pool.query`, through `pool.connect()` for transactions, and through whatever it
does next release.

## Decision

**The server span is application code. Postgres is the only auto-instrumented
library.**

- `src/plugins/tracing.ts` starts a `SERVER` span in `onRequest` and ends it in
  `onResponse`, for requests whose matched route starts with `/api/` and no
  others. Health, readiness, `/metrics`, and static assets are the highest-volume
  and least interesting requests the server handles.
- **The span's attributes are an allowlist of three**: `http.request.method`,
  `http.route` (the template, never the concrete path), and `app.request_id`. No
  path, no query string, no headers, no body, no user id, no email, no client IP.
  An integration test asserts the exact key set, so adding a fourth attribute is a
  deliberate act with a failing test in front of it.
- `@opentelemetry/instrumentation-pg` runs with `enhancedDatabaseReporting: false`
  (parameterised SQL, no values) and `requireParentSpan: true` (no orphan spans
  from migrations or `/readyz`).
- `instrumentation-http`, `instrumentation-fastify`, `sdk-node`, and
  `auto-instrumentations-node` are all rejected. The first two produce a worse
  server span than Fastify's own hooks can, and the last two pull in patches for
  libraries this application does not run.
- `src/telemetry.ts` is a single self-starting, idempotent module used two ways:
  as the `--import` target so `pg` is patched in time, and imported by
  `src/index.ts` for `shutdownTracing()`. ESM keys modules by resolved URL, so
  those are the same instance. Started without the flag — `node dist/index.js`,
  `tsx`, a test runner — server spans still work, Postgres spans do not, and the
  boot line says `pgInstrumented: false`.
- **An inbound `traceparent` contributes its trace id and nothing else.** The
  sampler is `ParentBased` with the ratio applied to root, remote-sampled, and
  remote-not-sampled alike, so a caller on the public internet cannot raise our
  export volume by setting the sampled flag.
- The preload path is a literal in the entrypoint, never read from an environment
  variable. A module path from the environment is an arbitrary-code-load
  primitive for anyone who can set env on the application.

## Consequences

Roughly seventy lines of hook code exist that a library could have provided, and
they are ours to maintain against Fastify's hook API. That is the price of an
attribute allowlist instead of a scrubber, and of an integration test that can
assert real spans with `InMemorySpanExporter` in-process, with no loader flag in
the test runner.

Spans stop at the process boundary. There is no outbound HTTP instrumentation, so
when F-018 adds a mail provider its call will not appear as a child span until
someone adds one — deliberate, and cheap to add at that point, since the active
context is already correct inside a request.

`http.route` on the span and the `route` label on `http_request_duration_seconds`
come from the same Fastify field, so a dashboard and a trace search agree on what
a route is called. That was the reason to prefer the framework's own knowledge
over an instrumentation's reconstruction of it.

The `--import` flag is now part of how the server starts. It is one word in
`scripts/docker-entrypoint.sh` and `package.json`, and the failure mode if the
built file is absent is a crashloop that holds the previous revision — visible,
not silent. `scripts/verify-tracing.mjs` runs against the built output for exactly
this reason.

An operator reading a log line during a request gets `traceId` and `spanId` from
the pino mixin whether or not the span was sampled, because head sampling still
yields a valid trace id. A trace id that finds nothing in a backend means "not
sampled", not "lost" — worth knowing before someone spends ten minutes on it.
