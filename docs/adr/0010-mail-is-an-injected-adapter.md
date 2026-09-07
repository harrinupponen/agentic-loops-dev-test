# 10. Mail is an injected adapter, dispatched off the response path

Date: 2026-09-07
Status: Accepted

## Context

F-004 is the first feature that has to talk to something outside this process.
Everything the application does today is Postgres and the request itself: failures
are fast, local, and either succeed or throw. A mail provider is none of those. It
can be slow, it can be down, it can accept a message and drop it, and it is not
available in CI at all.

Three separate problems arrive together:

- **Testing.** Integration tests must never send real mail, and the password-reset
  flow cannot be tested end to end without the raw token, which by ADR 0009 exists
  nowhere except in the outgoing message.
- **Timing and status leaks.** Password reset must respond identically for a known
  and an unknown address. Anything that happens only on the known branch and takes
  measurable time — or that can fail and change the status code — reintroduces the
  enumeration oracle the identical response exists to close.
- **Environment.** There is no provider configured for production yet, and a
  development transport that prints a reset token is a credential written to
  stdout. In production that stdout is a log aggregator.

## Decision

**Mail is an interface, constructed in `buildApp`, passed to routes as an
argument.** Same pattern as `db`, `config`, and the idempotency hook. It is not a
Fastify decorator, not a module-level singleton, and not imported by the route
module.

```ts
export interface Mailer {
  readonly transport: string; // low-cardinality, for logs and metrics
  sendPasswordReset(message: { to: string; token: string; expiresAt: Date }): Promise<void>;
}
```

**Tests inject a fake through `BuildOptions`**, alongside the existing `logStream`
option. That is the only supported way to observe an outgoing message. There is no
test-only HTTP route, no "last message" endpoint, and no debug mode that returns a
token in a response — any of those would be a token oracle sitting in production
code, protected only by configuration.

**The send is dispatched without being awaited, and its outcome never reaches the
caller.** The handler commits its database work, hands the message to the adapter,
and replies. A rejection is logged and counted; it is not a `5xx`. A `5xx` that is
only reachable when an address exists is an enumeration oracle with extra steps.

**Every transport applies its own timeout.** Nothing may hang, in keeping with
AGENTS.md, and there is no request to abort once the response is gone.

**A transport that is unsafe in production refuses to construct there**, per
ADR 0007. The `console` transport prints the address and the raw token to stdout
so a developer can complete the flow locally; it throws under `NODE_ENV=production`.
The production-safe transport until a real provider exists is `drop`, which sends
nothing and says so in `mail_messages_total{transport="drop"}`.

## Consequences

Delivery is observable only through metrics and logs. `mail_messages_total`
becomes the single signal that mail is working, which makes it load-bearing rather
than decorative — and makes it worth alerting on, because the user has already
received their `202` by the time anything can go wrong.

That counter also reflects whether an address matched an account, so it is an
enumeration oracle for anyone who can read `/metrics`. `/metrics` is
unauthenticated today. Keeping it off the public internet stops being general
hygiene and becomes a control this ADR depends on; giving it real access control
belongs to F-008.

A message can be lost if the process is killed between the response and the send
completing. `SHUTDOWN_GRACE_MS` makes this narrow, and the user's recovery is to
ask again — which the cooldown permits after 60 seconds. Buying a stronger
guarantee means an outbox table and a worker, and that is a feature nobody has
asked for.

Production ships this capability dark: the endpoints exist, tokens are issued, and
nothing is delivered. That is deliberate and visible in a metric, rather than
hidden behind a flag that makes the deployed API differ from `openapi.json`.

Adding a real provider later is a new transport plus a new `MAIL_TRANSPORT` value.
No route, no test, and no interface changes — which is the whole reason the seam
is here.
