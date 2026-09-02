# 7. Security configuration fails closed at boot

Date: 2026-09-02
Status: Accepted

## Context

`ALLOWED_ORIGINS` defaults to an empty string, and `src/app.ts` registers the
CSRF Origin hook only when the allowlist is non-empty. An unset variable
therefore does not weaken the check — it removes it, silently, with no log line,
no metric, and no failing test. Nothing about a running deploy distinguishes
"origin check active" from "origin check absent".

This was latent while the only client was an API consumer. F-006 ships a
cookie-authenticated browser client, which is the situation the check exists for.

The same shape has already cost this project real incidents: a default that is
plausible, silent, and wrong only in the environment nobody exercises before
production. The existing counter-examples in `src/config.ts` are the ones that
work — a missing `DATABASE_URL`, a `COOKIE_SECRET` under 32 characters, and the
example cookie secret in production all throw at startup rather than at first
request.

## Decision

A security control's configuration is validated at boot, and the process refuses
to start when a control that should be active is not configured. Concretely:

- The check runs where the condition is actually knowable. For `ALLOWED_ORIGINS`
  that is `registerWebRoutes`, next to the filesystem check that decides whether
  a browser client is being served — not `loadConfig`, because `WEB_ROOT` is
  defaulted and a pure-environment check would pass in exactly the deployment
  that matters.
- It throws in every `NODE_ENV`. A rule that only applies in production is a rule
  that first runs during a production deploy.
- The failure is a startup exception, not a warning. `buildApp` rejects, the
  process exits non-zero, readiness is never reported, and the orchestrator keeps
  the previous revision.
- A boot log line records the control's state (`originCount`), so "is it on right
  now" is answerable from logs.
- Both halves are tested: that the app refuses to boot unconfigured, and that the
  control is effective once it boots.

## Consequences

Every place that builds the app after building the client must supply the
configuration. For F-006 that is `.env.example`, three CODEOWNERS-protected
workflow files, `scripts/dump-openapi.ts`, the integration test helper, and the
Sevalla staging and production environments. Missing one turns a CI job red
rather than shipping a weakened app, which is the trade being made.

Environment variables must be set before the code that requires them merges,
otherwise the first staging deploy fails at container start. This is safe — the
previous revision keeps serving — but it makes ordering part of the rollout plan.

Local development loses a working default: a developer serving the built client
must set `ALLOWED_ORIGINS`. `.env.example` carries the value, and the boot error
names the variable and what it protects.

This ADR generalises beyond F-006. New security controls added later —
verification requirements, signing keys, IP allowlists — are expected to follow
it rather than default to off.
