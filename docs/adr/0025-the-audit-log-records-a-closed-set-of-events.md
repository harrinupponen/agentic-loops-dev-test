# 25. The audit log records a closed set of events, with four fields, for 90 days

Date: 2026-09-14
Status: Accepted

## Context

An audit table is the most inviting place in an application to put "just a bit
more context". It starts as four columns and acquires an IP address, then a user
agent, then a `details jsonb` because the next event needed one field the others
did not, and then it is the largest collection of personal data in the system and
nobody can say what is in it — because what is in it depends on what every future
call site decided to pass.

This application has already refused pieces of that drift once. ADR 0015 rejected
storing an IP address on a session, and named F-014 as the likelier home for one
"because an event that expires is a much smaller promise than a column that lives
as long as a session". That is an invitation, and it should be declined
explicitly rather than quietly, because the reasoning that made it tempting is
still correct: an expiring event _is_ a smaller promise. It is just not a small
enough one.

The second pressure is the opposite of drift. The action set is a closed
enumeration, and the obvious way to enforce a closed enumeration in Postgres is a
`CHECK` constraint — the shape `idempotency_keys.status` already uses. But every
future security feature adds an action, and changing a `CHECK` means dropping and
recreating it, which `scripts/ci/migration-safety.mjs` classes as destructive and
forces into a PR of its own. A schema that makes recording a new event cost two
deploys is a schema that quietly teaches future planners to skip the audit event.

## Decision

**Four columns, seven actions, ninety days.**

A row is `(id, user_id, action, outcome, created_at)` and nothing else. `user_id`
is `NOT NULL` with `ON DELETE CASCADE`. `action` and `outcome` are plain `text`
with **no `CHECK` constraint**; the closed set lives in a TypeScript union that the
one writer accepts, and the read endpoint declares both as `z.string()` so that a
value written by a newer instance cannot make an older instance's response
serializer throw mid-deploy.

**Refused by name, so that adding any of them is a decision someone has to argue
for rather than a diff nobody notices:**

- **`details jsonb`.** The column that makes the table unauditable. Its contents
  are whatever each call site passes, so no review of the schema can tell you what
  personal data the table holds, and no retention or export story can be written
  against it. Any event needing structured detail needs a new column, in a
  migration, where it is visible.
- **IP address, truncated IP, or country.** ADR 0015's reasoning applies
  unchanged: it is worth exactly as much as `TRUST_PROXY` is correct, it is
  useless for "was that me?" on a mobile network, and 90 days of it is a rolling
  location history for every account.
- **User agent.** Already stored on the session it belongs to (ADR 0015), where it
  dies with that session. Copying it here gives attacker-controlled text a
  90-day life and a second place to be rendered unsafely.
- **Email address.** Already on `users`, reachable by a join for anyone entitled
  to it. Duplicating it here would mean the table survives an address change with
  a stale value, and would be the one field that could make an ownerless row
  meaningful — which is exactly what makes ownerless rows refusable.
- **Anything about todos.** Not security events. They would multiply the table's
  write volume by the entire product's traffic for no security value.
- **Email verification events.** Nothing in this application authorizes on
  verification (ADR 0011). Recording advisory state in a security log dilutes the
  log.

**Ninety days**, a constant in `src/lib/audit.ts` rather than an environment
variable, per ADR 0017: a retention period is a privacy decision that belongs in a
spec and an ADR, not in a `.env` where two environments can differ without anyone
noticing. Ninety rather than F-010's thirty because this table answers
retrospective questions and a month is routinely shorter than the gap between a
compromise and its discovery. Enforcement is ADR 0017's opportunistic sweep,
attached to the sign-in path on **both** outcomes, because the high-volume rows in
this table are written by an attacker rather than by the account's owner.

## Consequences

The table is small, boring, and completely describable in one sentence: who, what,
when. F-015 can export it without reading any code to find out what is in it, and
a reviewer can verify the privacy claim from the migration alone.

What is lost is context, and it is a real loss. "Somebody signed in at 03:14" does
not say from where, and the user cannot tell their own sign-in from an attacker's
by looking at the row. The compensating answer is that F-009 already ships the
mechanism for that question — the session list shows the device, and
revoke-everything-else resolves "I do not recognise one of these" without needing
the metadata to be precise. If that proves insufficient in practice, the correct
response is a new column in a migration with a stated retention and export story,
and an ADR superseding this one — not a `details` bag.

The absence of a `CHECK` constraint means the database will accept a typo'd action
string. The mitigation is that there is exactly one writer, it takes a union type,
and TypeScript rejects an unknown value at compile time. The trade is deliberate:
the constraint would catch a class of bug that the type system already catches, at
the price of making every future security feature's audit event a two-PR change.

Ninety days means the table holds roughly three times what F-010's trash does per
active account, and that a question older than a quarter cannot be answered at
all. Both numbers are chosen, not defaults, and changing either is a change to this
ADR.
