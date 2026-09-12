# 20. A cache invalidates a whole user, not a page

Date: 2026-09-12
Status: Accepted

## Context

F-012 puts a read-through cache in front of `GET /api/todos`. The list endpoint is
keyset-paginated (ADR 0002) and, since F-010, has a `deleted` dimension, so one
user's "todo list" is not one result — it is a family of results indexed by
`(deleted, completed, limit, cursor)`. Anything cached has to answer two questions:
which of those results are stored, and what happens to them when the user writes.

The write side is where the difficulty is, and F-010 made it worse in a way worth
stating precisely. A `PATCH` that flips `completed` moves a row between the
`completed=true` and `completed=false` results. A `DELETE` moves it between the live
list and the trash. A **restore clears `deleted_at` in place at the row's original
`created_at`** (ADR 0016), so it does not reappear at the top of the ordering — it
reappears in the middle, on whatever page its creation time puts it, which may be a
page the client has already scrolled past. The opportunistic retention sweep inside
the `DELETE` handler removes up to 100 expired rows from the trash view of the same
user in the same request. A single write therefore changes an unpredictable subset of
an unpredictable number of results.

The alternative to reasoning about that is not reasoning about it.

## Decision

**Any successful write to a user's todos discards every cached list result for that
user, in one operation, and nothing attempts to work out which pages were affected.**

Three mechanical consequences, which together are the design:

1. **One Redis key per user, not one per page.** The entry is a hash,
   `c:todos:{hmac(userId)}`, whose fields are the query variants
   (`v1:{live|trash}:{any|done|open}:{limit}`) and whose values are the serialised
   `{ items, nextCursor }` bodies. Invalidation is `DEL` on that one key. There is no
   `SCAN`, no key enumeration, no secondary index of "which pages contain row X", and
   no version counter to read before every hit.
2. **Only cursor-less requests are cached.** A request carrying a `cursor` goes
   straight to Postgres. Cursors are opaque values drawn from `created_at`, so their
   cardinality is the user's row count rather than a small fixed set; caching them
   buys hit rate on the pages that are requested least (nobody re-reads page 7) and
   pays for it in keyspace. The first page is what the web client fetches on every
   load and after every mutation, and it is the only page most users ever see.
3. **TTL is a backstop, not the invalidation mechanism.** `TODO_LIST_CACHE_TTL_SECONDS`
   defaults to 30. It exists to bound the two windows invalidation cannot close — a
   `DEL` that fails against an unreachable Redis, and a process that commits a write
   and dies before issuing one — not to be the thing that makes reads fresh.

Rejected alternatives:

- **Per-page keys with surgical invalidation.** Delete only the entries a given write
  could have affected. Every one of the five write paths would need its own rule, each
  rule would need to know the ordering, the filter dimensions, and (for restore) where
  in the keyset the row lands. A wrong rule does not fail a test in the way a wrong
  query does; it silently serves a todo the user deleted. This is the clever-and-fast
  option that AGENTS.md exists to talk us out of.
- **A per-user version counter in the key** (`GET ver` then `GET page`). Invalidation
  becomes `INCR` instead of `DEL`, which allows per-page keys without enumeration, but
  it adds a second round trip to every read, leaves superseded entries occupying memory
  until they expire, and buys only the deep pages that decision 2 already declined.
- **Caching pages per cursor with a short TTL and no invalidation at all.** Simplest of
  all, and the one that makes "I deleted it and it came back" a routine experience.

## Consequences

**A user's own writes destroy their own cache, so a write-heavy session gets no
benefit.** That is accepted: the traffic shape this targets is a client that lists far
more often than it writes, and a user actively editing is already paying for a
Postgres round trip on the write. The hit ratio is instrumented precisely so this
assumption is checkable rather than assumed — a hit ratio near zero in production
means the workload is not the one this was designed for, and the correct response is
to turn the cache off, not to make invalidation finer.

**Restore is handled for free, and that is the main thing this buys.** The hardest
case in the feature — a row reappearing mid-ordering at its original `created_at`,
affecting both the live list and the trash simultaneously — requires no special code,
because "discard everything for this user" is already the correct answer for it. A
per-page scheme would have needed the cleverest rule in the design for the case most
likely to be got wrong.

**The `deleted` dimension is in the field name, so the trash and the live list can
never be confused.** ADR 0016 predicted this exact bug ("a cache key that does not
include the deleted filter will serve the trash to the live view"); the field name is
where that prediction is answered, and there is an acceptance criterion for it.

**There is a race this does not close.** A read that misses, queries Postgres, and is
then descheduled can write its now-stale result into the cache _after_ a concurrent
write's `DEL` has landed. The window is one Postgres round trip, it requires the same
user to read and write concurrently (two tabs, or a client that fires both), and the
damage is bounded by the TTL. Closing it properly needs either a version fence read on
write-back or a lock, both of which cost a round trip on every read to fix a window of
tens of milliseconds. It is written down here rather than discovered later.

**Hash growth is attacker-influenced and therefore bounded.** `limit` is validated to
1..100 and the other two dimensions have 2 and 3 values, so a user can mint at most
600 fields in their own hash. The store caps a hash at 16 fields and drops it wholesale
beyond that, the same shape as the rate limiter's bounded fallback map — a cache that
ends the process by exhausting memory would be a worse outage than the latency it was
removing.

**Future writers of `todos` inherit an obligation.** Invalidation is an explicit call
in each write handler, not a hidden hook, for the reason ADR 0016 gives about
predicates: a reviewer reading one handler can see what it does. The cost is that a
future handler can forget. F-015 (account deletion) is the next one, and a cached page
outliving a deleted account by up to the TTL is the specific thing it must not do.
