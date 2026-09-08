# 12. Traces are generated and exported; the backend is a separate decision

Date: 2026-09-08
Status: Accepted

## Context

F-008 adds distributed tracing. The instrumentation question — what a span covers,
what it carries — is settled in ADR 0013. The question this ADR answers is where
the spans go, and the honest answer today is nowhere.

`docs/deployment-sevalla.md` describes the whole deployed environment: two Sevalla
applications, a managed Postgres, Cloudflare in front. There is no collector, no
Prometheus, no Grafana, no log aggregator, and no vendor. `/metrics` has been
authenticated since F-004 and is scraped by nothing; the counters that F-004 and
F-005 argued about are, in production, read by nobody. Adding a second unread
signal would be worse than adding none.

So the feature has to answer a question it cannot answer alone: what receives this
data, who pays for it, and where does it live. Three ways to go.

**Provision our own stack on Sevalla.** An OTel Collector, a Prometheus with a
persistent volume, a Grafana with its own login. Three long-lived services, three
more things to secure and upgrade, retention to size, and a monitoring stack whose
own outages nobody is monitoring. Several times the budget of the feature that
motivated it, and almost none of the work is tracing.

**Point at a SaaS backend.** Cheap to wire — one OTLP endpoint and one token — and
genuinely the likely end state. But choosing it means choosing a vendor, a
retention window, a data-residency posture, and a bill, then putting a credential
into two environments. Every one of those is a human's decision, and none of them
is improved by an agent making it inside a pull request about span plumbing.

**Ship the capability and leave it off.** The application can produce spans and
export them over OTLP to anything, and does so nowhere.

## Decision

**F-008 ships trace generation and export as a capability that is disabled in
every deployed environment.** `OTEL_EXPORTER_OTLP_ENDPOINT` is empty on staging and
production; with it empty no SDK is constructed, no provider is registered, and
the instrumentation hooks return immediately.

- Verification is local and real, not hypothetical: `ops/docker-compose.observability.yml`
  runs a collector, and `scripts/verify-tracing.mjs` boots the built server against
  an OTLP sink and asserts a Postgres span shares a trace id with its server span.
  The pipeline is proven; only the destination is missing.
- Enabling it later is one environment variable and a restart. No code change, no
  migration, no deploy of new behaviour.
- **The backend and the RED dashboards are F-019**, together, because a dashboard
  needs a datasource and the datasource is the decision. F-019 owns picking
  self-hosted or SaaS, the scrape path to a token-protected `/metrics`, the
  dashboard JSON, retention, and the alert thresholds.

## Consequences

**This feature has no effect in production on the day it merges.** That is the
third time this project has shipped something dark — ADR 0010's mail transport and
ADR 0011's verification are the others — and it deserves the same scepticism.
What is different here is that the missing piece is not a code path: mail is dark
because the transport does not exist, whereas tracing is dark because a human has
not chosen where to send data. The application side is complete and tested.

**The counters and histograms stay the production signal.** Until F-019, an
incident is investigated exactly the way it is investigated today: pino logs plus
`/metrics`, scraped by hand with a bearer token if necessary. F-008 does not
degrade that, and the pino `traceId` field is inert rather than misleading when
tracing is off.

**Spans are load-bearing the moment the endpoint is set, and nobody will have
rehearsed it.** The mitigations are in the feature rather than in a runbook: the
sampler defaults to 0.1 so the first hour of real export is bounded, the exporter
queue drops rather than blocks, the boot rule refuses plaintext export in
production, and `trace_spans_exported_total{outcome="failed"}` is what says the
collector is rejecting batches. F-019 inherits the obligation to watch that
counter for the first hour, the same way ADR 0010 put `mail_messages_total` on the
transport feature.

**If F-019 is never done, F-008 was dev-only work.** That is a real risk and it is
the reason this ADR is explicit rather than a sentence in a spec. The value that
survives even then is that local debugging gets query-level traces, which is where
most latency questions actually get answered, and that the decision left for a
human is a purchasing decision rather than an engineering one.
