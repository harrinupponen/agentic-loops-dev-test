# Observability

Three signals, two of which have existed since F-001: pino logs on stdout, and
prom-client metrics on `GET /metrics` behind `METRICS_TOKEN`. F-008 adds the
third — OpenTelemetry traces — and ships it **disabled in every deployed
environment**. Nothing receives spans yet; picking a backend is F-019's job, and
the reasoning is in [ADR 0012](adr/0012-traces-without-a-backend.md).

## Turning it on locally

Two commands, and spans appear in the collector's log:

```bash
docker compose -f ops/docker-compose.observability.yml up
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 TRACE_SAMPLE_RATIO=1.0 npm start
```

`npm start` runs the built server (`npm run build` first), which is what the
container runs and the only way to get Postgres spans — see "The preload" below.
`npm run dev` traces requests but not queries.

To prove the pipeline end to end without reading collector output, run
`make verify-tracing`: it boots the built server against an in-process OTLP sink
and asserts a `pg` span shares its server span's trace id, that no request-body
value reaches `db.query.text`, and that `SIGTERM` flushes the batch rather than
dropping it. It is not a PR gate — CI has no collector — and exits non-zero on
any failure.

## Configuration

| Key                           | Default        | Notes                                                                       |
| ----------------------------- | -------------- | --------------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `''`           | Collector **base** URL; `/v1/traces` is appended. Empty = tracing off.      |
| `OTEL_EXPORTER_OTLP_HEADERS`  | `''`           | `k=v,k2=v2` sent on every export. A credential; never logged, never a span. |
| `OTEL_SERVICE_NAME`           | `agentic-todo` | `service.name` on every span.                                               |
| `TRACE_SAMPLE_RATIO`          | `0.1`          | Head sampling for root spans and inbound `traceparent` alike.               |

`loadConfig` refuses to boot on three combinations, per
[ADR 0007](adr/0007-fail-closed-security-config.md): a plaintext `http://`
endpoint to a non-loopback host under `NODE_ENV=production` (the headers are a
credential); an endpoint that is not an absolute `http(s)` URL, in any
environment (a typo means silence); and headers set with no endpoint (a
credential nothing will use). A ratio outside 0–1 fails schema validation.

## What is instrumented

- **One `SERVER` span per `/api/*` request**, from `src/plugins/tracing.ts`.
  Health, readiness, `/metrics` and static assets are not traced: highest
  volume, least interest.
- **Its attributes are an allowlist of three** — `http.request.method`,
  `http.route` (the template, never the concrete path), `app.request_id` — plus
  `http.response.status_code` at `onResponse`. No path, no query string, no
  header, no body, no user id, no email, no client IP. An integration test
  asserts the exact key set, so a fourth attribute needs a deliberate change with
  a failing test in front of it ([ADR 0013](adr/0013-server-spans-are-ours.md)).
- **Postgres queries** as child spans, from `@opentelemetry/instrumentation-pg`
  with `enhancedDatabaseReporting: false` (parameterised SQL, values elided) and
  `requireParentSpan: true` (no orphans from migrations or `/readyz`).
- **Only 5xx marks a span failed.** A 400, 401 or 404 is the API working.
- **An inbound `traceparent` contributes its trace id and nothing else.** The
  sampler ignores the remote sampled flag, so a public caller cannot inflate
  export volume. Trace context is never echoed in a response.

## The preload

The server starts as `node --import ./dist/telemetry.js dist/index.js`, in
`scripts/docker-entrypoint.sh` and in `npm start`. ESM hoists imports, so nothing
called from `index.ts` runs early enough to patch `pg`; the preload is the only
moment that works. The path is a literal shipped in the image and is never read
from an environment variable.

Started without it the server still runs and still produces server spans — it
just produces no Postgres spans, and the boot line says so:

```json
{ "tracing": "disabled", "sampleRatio": 0, "pgInstrumented": true, "msg": "tracing ready" }
```

`pgInstrumented: false` on a deployed instance means the entrypoint change did
not take. That is the one line to read after deploying this feature.

## Watching the exporter

`trace_spans_exported_total{outcome="succeeded|failed"}` counts spans handed to
the collector. A rising `failed` while `succeeded` is flat means the collector is
rejecting batches — otherwise visible only on stderr. Both flat while traffic
flows means tracing is off, which in production is the expected reading until
F-019.

Export is out-of-band on a bounded queue (2048 spans) that drops when full, so a
slow or hostile collector costs spans and memory rather than request latency. The
flush on `SIGTERM` is capped at two seconds inside `SHUTDOWN_GRACE_MS`.

Every log line written inside a traced request carries `traceId` and `spanId`,
and the span carries `app.request_id` — the same value the error envelope
returns. A trace id that finds nothing in a backend means "not sampled", not
"lost".

## Cost

Not measured in CI: there is no collector there. The measurement to repeat by
hand when the ratio changes, or before enabling this anywhere real:

```bash
k6 run load/smoke.js                                    # tracing off
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
  TRACE_SAMPLE_RATIO=1.0 k6 run load/smoke.js           # tracing on, everything sampled
```

Budget: p95 on `POST /api/todos` within 10% of the first run and still under the
`p(95)<300ms` threshold `load/smoke.js` enforces. If it is not, the sampling
ratio is the first knob and the `pg` instrumentation is the first suspect.
