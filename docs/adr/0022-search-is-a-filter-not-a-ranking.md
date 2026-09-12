# 22. Search is a filter, not a ranking

Date: 2026-09-12
Status: Accepted

## Context

F-013 adds full-text search over todo titles. The conventional shape for search
is a ranked result set — `ORDER BY ts_rank(...) DESC`, best match first, paged
with `LIMIT`/`OFFSET`. This application paginates every list by keyset (ADR 0002),
and `AGENTS.md` states the rule without an exception: "Pagination. Keyset only,
never `OFFSET`."

The two cannot be combined. A keyset cursor is the sort key of the last row
returned, and the next page is expressed as a `WHERE` clause against that value.
That requires the sort key to be a stored, per-row, monotonic value the server can
compare against — `created_at` is; `ts_rank` is not. A rank is computed per query,
is not stored, is not stable across different queries, is not unique (over
one-line titles most matches score identically), and "rows ranked below this
score" is not a predicate any index can satisfy. Encoding `(rank, created_at, id)`
into an opaque token and recomputing the rank identically on the next request is
not a parameter on the existing pagination; it is a second pagination system
inside one endpoint.

So the real choice was: ranking with `OFFSET`, or recency without it.

There is also a data argument, and it is the one that settles it. `ts_rank` scores
by term frequency and position. A todo title is at most 500 characters, usually
about five words, and a search term appears in it once. Nearly every match scores
the same, so a relevance sort over this data would be an arbitrary order presented
as a meaningful one — and would need `created_at` as a tie-break regardless.
Recency, meanwhile, is a real signal on a to-do list: the row a user is hunting
for is more often a recent one.

## Decision

Search is one more filter on `GET /api/todos`, not a ranked endpoint.

1. **Results are ordered `created_at DESC`**, identically to every other list in
   the application, and page through the same keyset cursor with the same
   semantics. There is no relevance score anywhere in the response.
2. **The match is a `WHERE` condition** —
   `to_tsvector('english', title) @@ plainto_tsquery('english', $q)` — pushed onto
   the same condition array as `user_id`, `deleted_at`, `completed` and the
   cursor. It composes with all of them, including the trash: a search sees
   deleted rows exactly when the caller passes `deleted=true`, which is how the
   question ADR 0016 left open for F-013 is answered.
3. **No `OFFSET`, anywhere, for any endpoint.** ADR 0002 stands unamended.
4. **`plainto_tsquery`, never `to_tsquery`.** The function that reads
   user-supplied text must not have a syntax that can raise on it.

## Consequences

One endpoint, one pagination contract, one cursor shape, one set of edge cases.
A client that renders the todo list renders a search result with no changes, and
every future change to the list query — the `(created_at, id)` composite cursor
of issue #29, for instance — is made once rather than twice.

The cost is real and should be stated rather than discovered: **a user searching
a common word gets their most recent matches first, not their best matches
first.** With the default `limit=20` that is the twenty newest matching todos.
For a single-user to-do list with short titles this is close to what ranking
would have produced anyway, but it is not the same thing, and a UI must not imply
otherwise — F-023 inherits that constraint.

The condition under which to revisit this is specific: **if a todo ever grows a
long text body**, term frequency starts to discriminate, ranking starts to mean
something, and this decision should be reopened. Reopening it is cheap, because
relevance would arrive as a _new_ endpoint with its own pagination contract
rather than as a change to this one — nothing shipped here has to be unwound.

Rejected, for the record. **Ranking with `OFFSET`** breaks a rule the whole
project is built on and buys a poor ordering on this data. **A rank-encoded
opaque cursor** is a second pagination system, with its own correctness proof,
for one parameter. **A separate `GET /api/todos/search`** duplicates the limit
validation, cursor parsing, filters, response schema, cache policy and
authorization predicate in order to run a query that differs by one `AND` — the
same reasoning that made F-010 reject `GET /api/todos/deleted`.
