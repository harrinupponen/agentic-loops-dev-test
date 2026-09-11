# 15. A session row records the device, not the location

Date: 2026-09-11
Status: Accepted

## Context

F-009 lets a user list their own sessions and revoke the ones they do not
recognise. Recognition is the whole feature: a list of three identical rows
differing only in a timestamp does not tell anyone which one is the phone they
left on a train.

The `sessions` table currently holds `id`, `user_id`, `created_at`, and
`expires_at`. Nothing about the client is captured, so this is a decision about
what the application starts remembering about its users — taken once, here,
rather than drifting in one field at a time.

The obvious candidates are the `User-Agent` header and the client IP address.
Every consumer product shows both. Both are also personal data: F-015 will have
to export whatever this decision stores, and a stolen database dump discloses it.

## Decision

A session row records **the user agent string, truncated to 256 characters,
nullable**. It records **no IP address**, no derived geolocation, no ASN, and no
country.

- Captured once, at `createSession`, from `request.headers['user-agent']`.
  Absent or empty becomes NULL. It is never updated afterwards — a session
  belongs to the client that started it.
- Stored raw. No parsing into "Chrome on macOS": that is a dependency with a
  signature database that goes stale, and the string is perfectly legible to the
  person who produced it.
- Returned only to the account that owns the session, and **never written to a
  log line, a span attribute, or a metric label** — it is attacker-controlled
  text, and a newline in a log line is log injection.
- Treated as untrusted text by any client that renders it: `textContent`, never
  `innerHTML`.

## Alternatives rejected

**Record nothing; list timestamps only.** No new PII, no migration, and a feature
that cannot do its job. The counter-argument — that "sign out everywhere else"
makes recognition unnecessary — is half true, and it is why the absence of an IP
address is affordable. It is not enough to justify a list nobody can read.

**Record the IP address.** It answers "was that me?" better than any other single
field, and it turns `sessions` into a rolling record of where every user has been
for the last seven days. That dataset has to be exported under F-015, is the
field most likely to be pasted into a support ticket or a screenshot, and is
worth precisely as much as `TRUST_PROXY` is correct — a misconfigured proxy chain
makes it the load balancer's address for every session, which is worse than
nothing because it looks like data. The cost is unbounded and the benefit is
already covered by revoke-everything-else.

**Record a truncated IP (`/24`, `/48`) or a country.** The privacy mitigation
that sounds reasonable and fails on both sides: still enough to place someone in
a city, and too coarse to answer "was that me?" for anyone on a mobile network.

**Record a login timestamp history per device.** A different feature — that is an
audit log, it is F-014, and its events are time-bounded rather than living as
long as a session does.

## Consequences

Two users on identical browsers see two identical rows and must fall back to
`created_at` and the current-session marker. Accepted: the safe action in that
situation is to revoke both and sign in again, which the API supports directly.

If an IP address is ever genuinely needed, it arrives with a stated retention
period, a truncation rule, an export story, and a new ADR superseding this one —
and F-014's audit log is the likelier home, because an event that expires is a
much smaller promise than a column that lives as long as a session.

`user_agent` is nullable forever, not just until a contract migration. Sessions
created before this shipped have none, and a client that sends no header has
none; both are legitimate and the API reports `null` rather than inventing a
value.
