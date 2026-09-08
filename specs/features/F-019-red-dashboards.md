# F-019 · RED dashboards and a metrics backend

> Status is tracked in `specs/features.yaml`, not here.

## Problem

Nothing reads this application's telemetry. `/metrics` has exposed
`http_request_duration_seconds` since F-001 and four domain counters since F-004,
and has required a bearer token since F-004's review — and no scraper anywhere
sends that token, because no scraper exists. F-008 added spans that are exported
to nothing (ADR 0012). An operator asking "what is the error rate right now" has
one option: `curl` the endpoint by hand and read a text exposition format. There
is no rate, no error ratio, no latency percentile, no history, and nothing that
notices a regression while nobody is looking.

## Scope

**In scope**

- A decision, with an ADR, on where metrics and spans are stored: self-hosted on
  Sevalla or a SaaS backend
- Whatever makes `/metrics` reachable by that backend, including the bearer token
  it must send and where that credential lives
- RED dashboards as code in `ops/dashboards/`: rate, error ratio, and duration
  percentiles from `http_request_duration_seconds`, per route, plus panels for
  `idempotency_requests_total`, `password_reset_total`, `email_verification_total`,
  `mail_messages_total`, and `trace_spans_exported_total`
- Turning `OTEL_EXPORTER_OTLP_ENDPOINT` on in staging first, then production, and
  watching `trace_spans_exported_total{outcome="failed"}` for the first hour
- Alert thresholds, expressed in the same repository as the dashboards

**Out of scope**

- Any new application instrumentation. RED needs nothing that
  `src/plugins/metrics.ts` does not already emit; if a panel cannot be written
  from an existing series, say so rather than adding a metric to fit a dashboard.
- Logs. Aggregating pino output is its own decision with its own retention and
  PII questions.
- Removing or changing the `METRICS_TOKEN` control from F-004.

## Design

<!-- PLANNER: fill this in only once F-008 is merged. Points that need an explicit
     decision, in the order they block each other:

     - Self-hosted (collector + Prometheus + Grafana as Sevalla applications,
       with a persistent volume and retention sizing) or SaaS (one OTLP endpoint,
       one Prometheus remote-write or agent, one token, a bill). ADR 0012 rejected
       making this call inside F-008; it is the first thing to settle here, and it
       is a human's call, not the planner's.
     - How a scraper reaches /metrics. It shares the public port and requires
       Authorization: Bearer. A SaaS scraper cannot reach a private address, so
       either the agent runs alongside the app or the endpoint is scraped over the
       internet with the token. Say which, and what that implies for ADR 0007.
     - Where the scrape credential and any OTLP credential live, and what happens
       at boot when one is missing. METRICS_TOKEN is already a boot rule; a
       backend credential probably belongs in the backend, not in this app.
     - Dashboard provisioning: JSON in git, provisioned into Grafana, never edited
       in the UI. If the chosen backend cannot be provisioned from files, that is
       an argument against it worth writing down.
     - Alert thresholds and who receives them. An alert nobody receives is a
       comment. Start from the shapes the specs already name as page-worthy:
       mail_messages_total{outcome="failed"} rising, idempotency takeover
       non-zero, trace_spans_exported_total{outcome="failed"} rising, 5xx ratio,
       p95 against the k6 budget.
     - Retention and cost. Both signals, both environments.
     - Whether the local stack in ops/docker-compose.observability.yml grows a
       Prometheus and a Grafana so the dashboards can be verified before they are
       deployed, the way F-008 verified spans against a local collector. -->

## Acceptance criteria

<!-- PLANNER: at minimum these, plus whatever the design implies. -->

- [ ] A dashboard shows rate, error ratio, and p50/p95/p99 per route for the last
      24 hours of a deployed environment, from `http_request_duration_seconds`
      alone
- [ ] The dashboard definition lives in git and is provisioned from the file; an
      edit made in the UI is lost on the next deploy
- [ ] The backend scrapes `/metrics` successfully with a bearer token, and a
      scrape without one is still rejected
- [ ] Spans from a deployed environment are queryable, and a `pg` span can be
      found from a `traceId` in a log line
- [ ] At least one alert fires against a deliberately induced condition in staging

## Test plan

| Layer       | Cases |
| ----------- | ----- |
| unit        |       |
| integration |       |
| e2e         |       |
| load        |       |

## Security considerations

<!-- PLANNER: fill in. A scrape credential leaves this repository's control, the
     counters it protects are an enumeration oracle (F-004), and spans leave the
     perimeter for the first time (ADR 0012, ADR 0013). If the backend is
     internet-reachable, so is a dashboard describing this system's traffic. -->

## Observability

<!-- PLANNER: fill in. What watches the thing that watches everything else — a
     dead scraper and a healthy one look identical from inside the application
     except for `up` on the backend side. -->

## Rollout

<!-- PLANNER: fill in. Staging first, production second, and the first hour of
     real export watched with trace_spans_exported_total. What the off switch is
     for each half. -->
