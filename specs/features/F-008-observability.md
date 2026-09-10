# F-008 · OpenTelemetry traces

> Status is tracked in `specs/features.yaml`, not here.

## Problem

When a request is slow or fails, the only evidence is a duration bucket and a log
line. `http_request_duration_seconds` says `POST /api/todos` took 900 ms; nothing
says whether that was Argon2, the session lookup, the insert, the idempotency
claim, or a connection the pool made it wait for. Logs carry a `requestId` but no
causal structure, so reconstructing one request means grepping and guessing at
ordering. There is no way to answer "what did _this_ request actually spend its
time on", which is the question every latency investigation starts with.

## Scope

**In scope**

- A tracer provider, sampler, and OTLP/HTTP span exporter, started before the
  application module graph loads, and **inert unless an endpoint is configured**
- One `SERVER` span per `/api/*` request, produced by a Fastify plugin: route
  template, method, status, and the request id, and nothing else
- Postgres spans as children of that span, via `@opentelemetry/instrumentation-pg`
- W3C `traceparent` extraction, with the remote sampling decision deliberately
  ignored
- `traceId`/`spanId` on every log line emitted inside a traced request
- Boot-time validation of the new configuration, failing closed per ADR 0007
- Span flushing on `SIGTERM`, inside the existing shutdown sequence
- A minimal local collector (`ops/docker-compose.observability.yml`) and a
  `verify:tracing` script that proves the whole pipeline end to end
- `docs/observability.md`: what is instrumented, how to turn it on, what it costs

**Out of scope**

- **A production tracing backend.** No collector, vendor, or credential is
  provisioned by this feature, and nothing is enabled in staging or production.
  See ADR 0012 and the backlog split below.
- **RED dashboards, Prometheus provisioning, and alert rules** — split out to
  F-019, because a dashboard needs a datasource and the datasource _is_ the
  backend decision. Everything RED needs from the application already exists:
  `http_request_duration_seconds` gives rate (`_count`), errors (`status` label),
  and duration (`_bucket`) with no new instrumentation.
- **Access control on `/metrics`.** Already shipped: `METRICS_TOKEN` bearer auth
  landed in F-004 by review decision (`src/plugins/metrics.ts`, `src/config.ts`,
  `tests/integration/metrics.test.ts`). Nothing here changes it.
- **Moving `/metrics` to a separate port or network** — F-004's rollout parked
  this on F-008. Rejected here rather than deferred again; see "Key decisions".
- **Metrics or logs over OTLP.** prom-client and pino stay exactly as they are.
  This feature adds a third signal, it does not migrate the first two.
- **Tail sampling, span-derived metrics, exemplars, service maps.** All of them
  are collector- or backend-side features, and there is no backend.
- **Tracing outbound HTTP.** There is none: `MAIL_TRANSPORT` is `drop` in every
  deployed environment (ADR 0010). F-018 adds the first outbound call and can add
  its own span.
- **Any new user-visible behaviour, route, response field, or database change.**

## Design

### API changes

No new routes, no changed responses, no `openapi.json` regeneration.

| Method | Path      | Auth      | Notes                                                                                                                                     |
| ------ | --------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| \*     | `/api/**` | unchanged | Optional `traceparent` / `tracestate` **request** headers are read when present. Absent → a new trace. Never rejected, never echoed back. |

No `traceparent` is added to responses. Nothing about the response body, status,
or headers changes on any route, which is why no OpenAPI change follows.

### Configuration

Four new keys in `src/config.ts` and `.env.example`:

| Key                           | Type        | Default        | Meaning                                                                                         |
| ----------------------------- | ----------- | -------------- | ----------------------------------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | string      | `''`           | Collector **base** URL, e.g. `http://localhost:4318`. Empty = tracing off, nothing constructed. |
| `OTEL_EXPORTER_OTLP_HEADERS`  | string      | `''`           | `k=v,k2=v2` sent on every export. A credential for a SaaS endpoint. Never logged.               |
| `OTEL_SERVICE_NAME`           | string      | `agentic-todo` | `service.name` resource attribute.                                                              |
| `TRACE_SAMPLE_RATIO`          | number, 0–1 | `0.1`          | Head sampling ratio for root and remote-parent spans.                                           |

The first three use the standard OTel names because that is what an operator
pointing a collector at this app will reach for. `TRACE_SAMPLE_RATIO` is ours: we
build the sampler explicitly rather than letting the SDK auto-configure it, so
borrowing `OTEL_TRACES_SAMPLER_ARG` would name a knob we do not honour the rest of
the semantics of. The exporter URL is joined as
`` `${base.replace(/\/$/, '')}/v1/traces` `` — the config key is a base URL in
every environment, and the signal path is never something an operator has to
remember.

**Boot rules, in `loadConfig`, ADR 0007 shape — the process refuses to start:**

1. `NODE_ENV=production`, endpoint set, scheme is not `https:` and the host is
   not `localhost`/`127.0.0.1`. Plaintext OTLP to anywhere but a sidecar puts
   `OTEL_EXPORTER_OTLP_HEADERS` — a credential — on the wire in clear.
2. Endpoint set but not parseable as an absolute `http(s)` URL. In every
   `NODE_ENV`: a typo here means silence, and silence is the failure mode this
   whole feature exists to remove.
3. `OTEL_EXPORTER_OTLP_HEADERS` set while the endpoint is empty. That
   configuration means somebody believes tracing is on when it is off, and it is
   also a credential sitting in an environment for no reason.

`TRACE_SAMPLE_RATIO` outside 0–1 is a zod failure, like every other bound.

### Data model changes

**None.** No migration, no schema change, no new table, no index, no backfill —
so there is no expand/contract plan to state and nothing in the database to undo
on rollback. This is the first feature since F-001 with no `drizzle/` file, which
is worth saying out loud because it removes the usual rollout risk entirely.

### Files

| File                                                              | Change                                                                                                       |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `src/telemetry.ts`                                                | **new.** Self-starting, idempotent. Provider, resource, sampler, exporter, pg patching, `shutdownTracing()`. |
| `src/plugins/tracing.ts`                                          | **new.** Fastify hooks that own the server span.                                                             |
| `src/app.ts`                                                      | Register the plugin; add a pino `mixin` for `traceId`/`spanId`.                                              |
| `src/index.ts`                                                    | `await shutdownTracing()` in the existing `shutdown()`, before `process.exit`.                               |
| `src/config.ts`, `.env.example`                                   | The four keys and the three boot rules.                                                                      |
| `src/plugins/metrics.ts`                                          | Registers the export counter owned by `src/telemetry.ts` (see Observability).                                |
| `Dockerfile` / `scripts/docker-entrypoint.sh` / `package.json`    | `node --import ./dist/telemetry.js dist/index.js`.                                                           |
| `ops/docker-compose.observability.yml`, `ops/otel-collector.yaml` | **new.** Local collector, dev only, never deployed.                                                          |
| `scripts/verify-tracing.mjs`                                      | **new.** Built server + in-script OTLP sink + assertions.                                                    |
| `docs/observability.md`                                           | **new.** How to turn it on and what it emits.                                                                |

### How the span gets made

**`src/telemetry.ts` is loaded twice over and starts once.** Node's `--import`
runs it before the application's module graph is evaluated, which is the only
moment at which `@opentelemetry/instrumentation-pg` can patch `pg`. `src/index.ts`
then imports the same specifier for `shutdownTracing()`; ESM keys modules by
resolved URL, so that is the same instance and not a second start. A module-level
guard makes a second call a no-op, so running `node dist/index.js` without the
flag still works — server spans are produced, Postgres spans are not, and a
`warn` line says so.

With no endpoint configured the module returns immediately: no provider is
registered, `trace.getTracer()` hands back the API's no-op, and the Fastify hooks
below cost one `getTracer` call and a branch.

**`src/plugins/tracing.ts` owns the server span** — there is no
`instrumentation-http` and no `instrumentation-fastify` (see "Key decisions").

- `onRequest`, first hook after the session loader: skip unless
  `request.routeOptions.url` starts with `/api/`. Extract the parent with
  `propagation.extract(context.active(), request.headers)`, start a `SERVER` span
  named `` `${method} ${route}` ``, and keep it on `request` plus the active
  context for the rest of the request via `context.with`.
- Attributes, and this is the complete list: `http.request.method`, `http.route`
  (the template — `/api/todos/:id`, never the concrete path), and
  `app.request_id` (the same value the error envelope returns, so a log line and
  a trace join in either direction).
- `onError`: `span.recordException(err)` and `ERROR` status **only for 5xx**. A
  4xx is the API working.
- `onResponse`: set `http.response.status_code`, set `ERROR` status for 5xx, end
  the span.

**Postgres spans** come from `PgInstrumentation({ enhancedDatabaseReporting: false, requireParentSpan: true })`.
The first flag keeps parameter _values_ out of `db.statement`; the second means a
query with no active request — migrations, `/readyz`'s `select 1` — produces no
orphan span at all.

**Sampling** is `ParentBasedSampler` over `TraceIdRatioBasedSampler(TRACE_SAMPLE_RATIO)`
configured so that `root`, `remoteParentSampled`, and `remoteParentNotSampled` all
consult the ratio. A `traceparent` from the public internet therefore contributes
its trace id — useful the day there is an upstream service — and contributes
nothing to whether we pay to export the span.

**Export** is `BatchSpanProcessor` with `maxQueueSize: 2048` and drop-on-full, so
a dead collector costs bounded memory and dropped spans rather than backpressure
into request handling. OTel's `diag` logger is wired to `ERROR` only.
`shutdownTracing()` flushes with a 2-second cap inside the existing
`SHUTDOWN_GRACE_MS` window; a flush that fails is logged and never blocks exit.

**Log correlation** is a pino `mixin` in `src/app.ts` reading
`trace.getActiveSpan()?.spanContext()`. One place, covers `app.log` and
`request.log` alike, and adds nothing when tracing is off.

### Key decisions

Two ADRs: **`docs/adr/0012-traces-without-a-backend.md`** (what ships and what
does not) and **`docs/adr/0013-server-spans-are-ours.md`** (how it is wired).

**Traces are generated and exported; no backend is chosen or provisioned.**
Nothing in `docs/deployment-sevalla.md` describes an observability backend, and
nothing scrapes `/metrics` in production today either. Three options, and the
third is chosen:

- _Provision a collector plus Prometheus plus Grafana on Sevalla._ Rejected for
  now: three long-lived services, a persistent volume, another ingress, another
  set of credentials, and a monitoring stack whose own failures nobody is
  monitoring — several times this feature's budget, and none of it is tracing.
- _Point at a SaaS backend._ Rejected as an agent decision, not as an idea: it
  picks a vendor, a data-residency posture, and a bill, and it puts an API token
  into two environments. That is a human's call, and it is F-019's.
- **Chosen: ship the capability disabled.** `OTEL_EXPORTER_OTLP_ENDPOINT` empty
  everywhere, verified locally against a collector in `ops/`. The honest cost is
  that this feature has **no effect in production on the day it merges** — the
  same "ships dark" shape as ADR 0010, and the reason ADR 0012 exists instead of
  a comment. What it buys is that turning tracing on later is one environment
  variable and a restart, not a feature.

**No `instrumentation-http`, no `instrumentation-fastify`, no `sdk-node`.**
Rejected `@opentelemetry/auto-instrumentations-node` outright: dozens of
transitive instrumentations for libraries this app does not run, for a lockfile
already gated by human review. Rejected the two individual Fastify/HTTP packages
because the server span they produce is worse than the one we can write: Fastify
already knows the exact route template at `onResponse` (that is how the metrics
histogram keeps its cardinality bounded), `instrumentation-fastify` emits a span
per hook, and `instrumentation-http` records `url.full` and `url.query` by
default. Writing the span ourselves is ~70 lines, has an attribute allowlist
rather than a scrubber, and is assertable in-process with `InMemorySpanExporter`
— no loader flag required in the test runner.

**Postgres is the one exception, and it is what forces `--import`.** Query spans
are the actual product of this feature; a wrapper around `pg.Pool` would have to
cover `query`, `connect`, and the `PoolClient` path that transactions take
(`src/routes/auth.ts` uses one), and it would rot silently the next time Drizzle
changes how it acquires a connection. So: one instrumentation package, and the
`--import ./dist/telemetry.js` preload that ESM requires for it to patch a CJS
dependency in time.

**Seven new dependencies** (`@opentelemetry/api`, `sdk-trace-node`, `resources`,
`semantic-conventions`, `core`, `exporter-trace-otlp-http`, `instrumentation`
plus `instrumentation-pg`), all runtime, all from the OTel org. AGENTS.md rule 7
means the PR body justifies them line by line; `@opentelemetry/api` is the only
one application code imports.

**Only `/api/*` is traced.** Health, readiness, `/metrics`, and static assets are
the highest-volume requests this server serves and the least interesting; a
prefix check is cheaper and more legible than an ignore-hook list.

**No client IP, no user id, no email, no path, no query string, no headers on any
span.** The attribute list above is exhaustive and closed by test. Spans are the
one signal designed to leave the perimeter, and every one of those fields is
either personal data or a place a token could hide. `app.request_id` is the join
key to logs, which is where per-user context already lives under existing rules.

**`/metrics` stays on the application port — F-004's parked question, answered
"no".** A Sevalla application exposes one HTTP port; a second listener is a second
process and another ingress to secure, and the endpoint has had a constant-time
bearer check since F-004. Splitting the port would add infrastructure to protect
something that is already authenticated. If the backend F-019 picks needs a
private scrape path, that is where the requirement reappears — with a scraper
attached to it, rather than as hygiene nobody can observe.

**Default sample ratio 0.1.** With no endpoint configured the ratio is inert, so
the default's only job is to be a safe first value on the day someone sets an
endpoint. `ops/docker-compose.observability.yml` and `.env.example` document
`1.0` for local work, where sampling only hides the span you were looking for.

### Backlog split

**F-019 "RED dashboards and a metrics backend" is added to the backlog**, deps
`[F-008]`, tags `[infra, observability, security]`. It owns: the datasource
decision (self-hosted or SaaS), the scrape path to a token-protected `/metrics`,
the dashboard JSON in `ops/dashboards/`, alert thresholds, and turning
`OTEL_EXPORTER_OTLP_ENDPOINT` on in a deployed environment.

The cut is at the datasource because that is where the work actually divides: a
RED dashboard is four PromQL expressions over a histogram this repo has had since
F-001, and every hour of the remaining work is provisioning, credentials, and
retention. Keeping them together would put a vendor choice and a payment decision
inside a feature about span plumbing, and would put the diff over budget twice
over. F-008's title in `specs/features.yaml` narrows to "OpenTelemetry traces" to
match.

## Acceptance criteria

- [ ] With `OTEL_EXPORTER_OTLP_ENDPOINT` unset, no tracer provider is registered,
      no span is recorded, and every existing test passes unchanged —
      `integration: tracing is inert when no endpoint is configured`
- [ ] `POST /api/todos` produces exactly one `SERVER` span named
      `POST /api/todos` whose `http.route` is the template and whose
      `http.response.status_code` is 201 —
      `integration: emits one server span per API request`
- [ ] That span's `app.request_id` equals the `requestId` the API returns in an
      error envelope for the same request —
      `integration: the span carries the request id used in responses`
- [ ] A traced request's span attributes contain no query string, no concrete
      path, no cookie or authorization header, no email address, no user id, and
      no client IP — the assertion is an exact-set comparison against the three
      allowed keys — `integration: server spans carry only allowlisted attributes`
- [ ] `GET /healthz`, `GET /readyz`, `GET /metrics`, and a static asset produce no
      spans — `integration: infrastructure routes are not traced`
- [ ] A handler that throws produces a span with `ERROR` status and a recorded
      exception; a `401` and a `404` produce spans with unset status —
      `integration: only 5xx marks a span as failed`
- [ ] A request carrying a valid `traceparent` produces a span with that trace id
      and the header's span id as parent —
      `integration: adopts an inbound traceparent`
- [ ] A `traceparent` with the sampled flag set does not raise the sampling rate:
      at ratio 0, an inbound sampled parent still yields a non-recording span —
      `unit: remote parents do not override the sampler`
- [ ] A log line written during a traced request carries `traceId` and `spanId`
      matching the active span — `integration: logs carry the trace id`
- [ ] `loadConfig` throws for: an `http://` endpoint under `NODE_ENV=production`
      with a non-loopback host; an unparseable endpoint in any environment;
      headers set with no endpoint; a ratio above 1. And accepts
      `http://localhost:4318` in production — `unit: config.test.ts`, one case each
- [ ] The exporter URL is the configured base plus `/v1/traces`, with exactly one
      slash, for bases with and without a trailing slash —
      `unit: builds the traces endpoint from the base URL`
- [ ] `npm run verify:tracing` boots the **built** server against a local OTLP
      sink, issues one authenticated `POST /api/todos`, and asserts: a server span
      arrives, at least one child `pg` span shares its trace id, the `db.statement`
      contains no literal values from the request body, and a `SIGTERM` flushes
      rather than drops the batch — `script: scripts/verify-tracing.mjs`, exit
      non-zero on any failure
- [ ] `docker compose -f ops/docker-compose.observability.yml up` plus
      `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` makes spans visible in
      the collector's debug output, and `docs/observability.md` states those two
      commands verbatim
- [ ] `make ci` passes with no new environment variables set anywhere in CI

## Test plan

| Layer       | Cases                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| unit        | The four `loadConfig` rules, accept and reject, including the loopback exception · exporter URL joining with and without a trailing slash · sampler: root at ratio 0/1, remote-sampled parent at ratio 0, remote-not-sampled parent at ratio 1 · `shutdownTracing()` is a no-op when tracing never started · the `/api/` prefix predicate                                                                                                                                                                                                                                                                                            |
| integration | `tests/integration/tracing.test.ts`, a `NodeTracerProvider` with `InMemorySpanExporter` registered by the test before `buildApp`: happy path (one span, name, attributes, status) · **validation failure** (400 → span exists, status unset) · **unauthenticated** (401 → span exists, no user data on it) · **another user's todo** (404 → span exists, no id of the other user's row anywhere in the attributes) · 500 → `ERROR` + exception · ignored routes → zero spans · inbound `traceparent` adopted · attribute allowlist as an exact set · log lines carry `traceId` · endpoint unset → zero spans and unchanged responses |
| e2e         | None, deliberately, and for the same reason F-004 and F-005 argued: there is no browser surface, and Playwright runs against `STAGING_URL` where tracing is off by construction. The end-to-end proof that matters here is the exporter and the `pg` patching, which no browser can observe — `scripts/verify-tracing.mjs` is that test, run by `make verify-tracing` and by a step in `nightly.yml` after the soak job.                                                                                                                                                                                                             |
| load        | Not a PR gate — CI has no collector. Manual, recorded in `docs/observability.md`: `k6 run load/smoke.js` with tracing off, then on at ratio 1.0 against the local collector. Budget: p95 on `POST /api/todos` within 10% and under the existing `p(95)<300ms` threshold. If it is not, sampling ratio is the first knob and the pg instrumentation is the first suspect.                                                                                                                                                                                                                                                             |

## Security considerations

**Spans are the first signal designed to leave the perimeter.** Logs stay on the
host and `/metrics` is pulled behind a bearer token; a span is pushed to whatever
`OTEL_EXPORTER_OTLP_ENDPOINT` names, potentially a third party. That is why the
attribute list is an allowlist of three keys closed by an exact-set assertion,
rather than a scrubber applied to whatever an instrumentation decided to record.
No path, no query string, no header, no body, no user id, no email, no IP. The one
foreign attribute source is `instrumentation-pg`, pinned to
`enhancedDatabaseReporting: false` so `db.statement` is parameterised SQL with the
values elided — `insert into "todos" ... values ($1, $2)`, never the title.

**`OTEL_EXPORTER_OTLP_HEADERS` is a credential.** It is never logged, never put on
a span, and never included in an error message; the boot log line says
`tracing: enabled|disabled` and the ratio, nothing else. Under
`NODE_ENV=production` it cannot be sent over plaintext HTTP to a non-loopback
host — the process refuses to start, per ADR 0007 and rule 1 above. It joins
`COOKIE_SECRET` and `METRICS_TOKEN` in `.env.example` as a key with an empty
default and a comment explaining the boot rule.

**Inbound `traceparent` is attacker-controlled input.** Two consequences, both
handled: it cannot force sampling (the sampler ignores the remote decision, so
nobody can inflate export volume or a future bill by looping requests with
`-01`), and a malformed header is dropped by the W3C propagator rather than
raising — the request proceeds untraced. `tracestate` is carried but never read.
No trace context is echoed in a response, so this cannot be used as a reflection
channel.

**The `--import` preload is a code-execution path in the container.** It is a file
we build and ship in the image, referenced by a literal path in the entrypoint —
not from an environment variable, which would be an arbitrary-module-load
primitive for anyone who can set env on the app.

**Denial of service.** A slow or hostile collector cannot stall a request: export
is out-of-band on a bounded queue that drops when full, and the flush at shutdown
is capped at 2 seconds. A collector that returns 500s costs one counter increment
and one `diag` error line per batch.

**Auth surface.** None. `src/plugins/auth.ts`, `src/routes/auth.ts`,
`src/lib/session.ts`, and `src/lib/password.ts` are untouched. The tracing hook
runs after the session loader and reads nothing from `request.user`.

**PII.** None reaches a span, by the allowlist. Trace ids are random and carry no
account linkage. The one indirect exposure is that a span set is a traffic
pattern, which is why the endpoint is https-only in production.

## Observability

The feature is the observability, so what matters here is proving _it_ works:

- **`trace_spans_exported_total{outcome="succeeded|failed"}`** — a prom-client
  counter created by `src/telemetry.ts` (with `registers: []`, since the preload
  runs before `registerMetrics` exists) and registered onto the existing custom
  registry by `src/plugins/metrics.ts`. It wraps the exporter's result callback.
  Without it, a collector that started rejecting batches is invisible outside
  stderr. A rising `failed` while `succeeded` is flat is the page-worthy shape;
  both flat while traffic flows means tracing is off, which in production is the
  expected reading until F-019.
- **One boot log line**, next to `metrics endpoint ready`:
  `{ tracing: 'enabled'|'disabled', sampleRatio, pgInstrumented }`. `pgInstrumented`
  is false when the process was started without `--import`, which is the one
  misconfiguration that silently halves the feature's value.
- **`traceId` and `spanId` on every request-scoped log line**, so an operator
  holding a log line can pivot to the trace, and `app.request_id` on the span so
  they can pivot back.
- **`http_request_duration_seconds` is the control.** Its p95 before and after
  enabling tracing at ratio 1.0 is what says whether the instrumentation costs
  anything; the load-test row above is that measurement.
- **Not measured:** anything about span content, which lives in a backend nobody
  has yet. That is F-019's to answer.

## Rollout

**Ships disabled, in every environment, by construction rather than by flag.**
`OTEL_EXPORTER_OTLP_ENDPOINT` is unset on staging and production and this feature
does not set it. With it empty the SDK is never constructed, so the deployed
behaviour change is: one extra `--import` on the server command, two Fastify
hooks that return immediately for non-`/api/` routes, and a pino mixin that reads
a no-op span. No new environment variable is required anywhere — unlike
`METRICS_TOKEN` in F-004, nothing here can fail a deploy for want of a value.

**Order.**

1. Merge. No migration, no config precondition, no `openapi.json` change.
2. Confirm on staging that the boot line reads
   `{ tracing: 'disabled', pgInstrumented: true }`. `pgInstrumented: false` means
   the entrypoint change did not take, and is the one thing to look at.
3. Enabling it anywhere is F-019, together with the backend that would receive
   the spans.

**The riskiest line in the diff is the entrypoint**, because it is the only change
that can stop the container starting: `exec node --import ./dist/telemetry.js dist/index.js`.
If `dist/telemetry.js` were missing from the image, every instance would crashloop
and Sevalla would hold the previous revision — a failed deploy rather than a broken
one, which is the designed outcome, but it is why `verify:tracing` runs against the
**built** output and not against sources. `node dist/db/migrate.js` in the same
script is deliberately left without the flag: migrations need no spans and should
not depend on the telemetry module loading at all.

**Rollback at 2am.** Redeploy the previous image; nothing persists, nothing
migrated, no data was written anywhere. If tracing is somehow enabled and
misbehaving, unsetting `OTEL_EXPORTER_OTLP_ENDPOINT` and restarting is a complete
off switch — the code path is gone, not flagged off. Dropping
`TRACE_SAMPLE_RATIO` to 0 stops export without a restart cycle's worth of
downtime but leaves the hooks running, so it is a mitigation, not the switch.

**Diff budget.** ~510 hand-written lines: `src/telemetry.ts` (~120),
`src/plugins/tracing.ts` (~70), config and `.env.example` (~55), `app.ts`,
`index.ts`, `metrics.ts`, `Dockerfile`, entrypoint, `package.json` (~35),
`scripts/verify-tracing.mjs` (~70), unit tests (~70), integration tests (~90),
plus `ops/` config (~45) and `docs/observability.md` (~110), which are
configuration and prose rather than code. At the ~500 guidance, which is why
F-019 exists. **Cut order if it runs over:** first `scripts/verify-tracing.mjs`
and its nightly step, moving to F-019 where a collector exists anyway; second
`trace_spans_exported_total`, which is only load-bearing once something is
actually exporting. Never the attribute-allowlist test, the ignored-routes test,
or the sampler test — those three are the security properties of the feature.
