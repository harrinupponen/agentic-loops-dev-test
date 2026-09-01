# 5. Client-supplied idempotency keys with stored responses

Date: 2026-09-01
Status: Accepted

## Context

HTTP over the public internet is at-least-once. A client that sends
`POST /api/todos` and never sees a response cannot tell whether the request was
lost on the way out, executed and lost on the way back, or is still running. Its
two options are both wrong: retry and risk a duplicate, or give up and risk
losing the write. Proxies, mobile radios, and impatient users all produce this
case routinely.

`POST` is the only unsafe verb in the API today. `PATCH` and `DELETE` on
`/api/todos/:id` already converge — repeating them lands on the same state — so
the problem is confined to creation.

## Decision

Clients may attach an `Idempotency-Key` header to unsafe requests. The server
records the first outcome for a `(user_id, key)` pair in Postgres and replays the
stored response for a repeat of the same request.

1. **Postgres, not Redis.** The record must survive a restart and be visible to
   every instance; both point at the datastore already in the deploy. Redis
   arrives in F-011 for rate limiting, and even then this data wants durability
   more than it wants speed. One datastore until measurement says otherwise.
2. **Keys are scoped per user**, `PRIMARY KEY (user_id, key)`. A global key space
   would let one account collide with another's key — a denial-of-service lever
   and a signal about other accounts' activity. Per-user scoping also lets a
   client pick keys without coordinating with anyone.
3. **The key is paired with a request fingerprint** (sha256 of method, route, and
   canonical JSON body). Same key + same fingerprint replays; same key +
   different fingerprint is a client bug and returns `409`. Deduplicating on the
   fingerprint alone was rejected: two todos with the same title are a
   legitimate request, and the client must state its intent rather than have the
   server guess.
4. **Only success is stored.** A `2xx` is recorded; anything else releases the
   key. Caching a `500` would make a transient failure permanent for the whole
   TTL, and caching a `400` would stop a client from correcting itself.
5. **An in-flight duplicate gets `409`, not a wait.** Blocking the second request
   until the first finishes holds a connection from a bounded pool for the
   duration of someone else's work — one slow request becomes two. The retry
   budget stays with the client, which demonstrably has one.
6. **In-progress records carry a 60-second lease.** An instance killed mid-request
   would otherwise poison that key until the record expires. This is explicitly
   not a distributed lock: in the worst case two attempts run and the later one
   overwrites the stored response, which is exactly the behaviour that existed
   before idempotency keys — not a regression.
7. **Records expire after `IDEMPOTENCY_TTL_HOURS` (default 24) and are swept
   opportunistically** by the next keyed request from the same user, using the
   primary key's leading column. No background reaper: a cron loop is process
   state that must be owned, monitored, and made safe across instances, and this
   table is small.

## Consequences

Retry becomes safe for any client that opts in, and the header stays optional, so
existing clients are unaffected and no feature flag is needed.

The cost is two extra statements on the keyed write path (claim, then finalise;
plus an occasional sweep) and a table that grows with keyed traffic and shrinks
with expiry. The growth bound is the rate limit multiplied by the TTL — both
configuration, both adjustable without a deploy of new code.

The guarantee is honest rather than absolute: it is at-most-once **within the
lease and the TTL**, not exactly-once. Genuine exactly-once would require the
handler's write and the idempotency record to commit in one transaction. That is
achievable here and is the obvious next step if duplicates are ever observed —
it was left out because it means threading a transaction through the route
handler, which is a larger change than the problem currently justifies.

Adding a second idempotent endpoint later is opt-in per route: the storage,
fingerprinting, and hooks are shared, and the route declares that it participates.
