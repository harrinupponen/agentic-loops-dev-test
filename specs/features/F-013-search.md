# F-013 · Full-text search over todo titles

> Status is tracked in `specs/features.yaml`, not here.

## Problem

The only way to find a todo is to scroll to it. `GET /api/todos` returns one
user's todos newest first, 20 at a time, filtered by nothing but completion state
and — since F-010 — whether the row is in the trash. A user who wrote "call the
plumber" three months and four hundred todos ago has to page through everything
in between to find it again, and a user who cannot remember whether they wrote it
at all has no way to ask. The list grows monotonically, the cost of finding an
old todo grows with it, and the browser client (F-016) can only offer what the
API offers.

## Scope

**In scope**

- Finding a user's todos by words in the title, through the existing
  `GET /api/todos` endpoint, as one new `q` query parameter
- Composition with every filter the endpoint already has: `completed`,
  `deleted`, `limit`, and the `cursor`
- The same keyset pagination, the same cursor shape, and the same response body
  as a list without `q`
- Word-level matching with stemming, via Postgres' built-in text search — no new
  dependency, no new service
- A counter and a histogram that make the performance of this query visible in
  production, because performance is this feature's stated risk

**Out of scope**

- **A new endpoint.** Search is a filter on the list, not a second way to read
  todos. See "Key decisions".
- **Relevance ranking.** No `ts_rank`, no scoring, no "best match first". Results
  are ordered `created_at DESC` like every other list in this application. This
  is the decision most worth arguing with; it is argued for in
  [ADR 0022](../../docs/adr/0022-search-is-a-filter-not-a-ranking.md).
- **Prefix, substring, and fuzzy matching.** `gro` does not match `groceries`,
  and `grocerie` does not match `groceries`. Whole words after stemming only.
  Prefix matching needs `to_tsquery(... || ':*')` and substring or typo tolerance
  needs a `pg_trgm` index; both are new access paths, and this feature adds none.
- **Any new index, column, or migration.** Stated as scope rather than buried in
  the design, because the backlog entry assumed one. See "Data model changes".
- **Searching anything but `title`.** It is the only text a todo has.
- **Highlighting matched terms, snippets, or a match count.** `ts_headline` is a
  per-row cost on the hot path for a field that is at most 500 characters and is
  rendered whole anyway.
- **Browser screens.** F-016's list screen gains no search box here. **F-023**,
  added to the backlog by this plan, owns that. See "Backlog split".
- **Caching search results.** Decided explicitly, not left to fall out of F-012's
  existing code. See "Interaction with F-012's cache".

## Design

### API changes

One new query parameter on one existing endpoint. No new route, no response-shape
change, no new header, and no change to any other endpoint in
`src/routes/todos.ts`.

| Method | Path                     | Auth    | Notes                                                                                                                        |
| ------ | ------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/todos`             | session | Gains `&q=<text>` (optional, 1–100 chars after trim). Filters by words in the title; composes with every existing parameter. |
| POST   | `/api/todos`             | session | Unchanged.                                                                                                                   |
| GET    | `/api/todos/:id`         | session | Unchanged.                                                                                                                   |
| PATCH  | `/api/todos/:id`         | session | Unchanged.                                                                                                                   |
| DELETE | `/api/todos/:id`         | session | Unchanged.                                                                                                                   |
| POST   | `/api/todos/:id/restore` | session | Unchanged.                                                                                                                   |

`ListQuery` gains one field, next to `completed` and `deleted`:

```ts
q: z.string().trim().min(1).max(100).optional(),
```

The response body is `TodoListResponse` exactly as it is today — `{ items,
nextCursor }`, `nextCursor` still the `created_at` of the last row returned. A
client that already renders the list renders a search result with no changes, and
`openapi.json` gains one parameter and nothing else.

| Situation                                       | Response                                    | Notes                                         |
| ----------------------------------------------- | ------------------------------------------- | --------------------------------------------- |
| `?q=plumber` matching two of the caller's todos | `200 { items: [2 rows], nextCursor: null }` | Newest first, live rows only                  |
| `?q=plumber` matching nothing                   | `200 { items: [], nextCursor: null }`       | Not a `404`                                   |
| `?q=the` (only stop words)                      | `200 { items: [], nextCursor: null }`       | Empty `tsquery` matches nothing; see below    |
| `?q=` or `?q=%20%20`                            | `400 { code: "validation_failed" }`         | Empty after trim; zod, before the handler     |
| `?q=` over 100 characters                       | `400 { code: "validation_failed" }`         | Bounded input into `plainto_tsquery`          |
| `?q=x&deleted=true`                             | `200`, matching **deleted** rows only       | The existing parameter decides, not a new one |
| `?q=x&completed=true&limit=5`                   | `200`, matching completed rows, 5 at a time | All filters compose in one `WHERE`            |
| `?q=x&cursor=<ISO>`                             | `200`, the next page of the same search     | Same cursor semantics as any list             |
| `?q=x` matching another user's todo             | That row is never returned                  | `user_id = $caller` is in the same `WHERE`    |
| Any of these without a session                  | `401 { code: "unauthorized" }`              | `requireAuth`, unchanged                      |

**`q` is a filter, not a mode.** Everything the list already does, it keeps doing
when `q` is present: `deleted=false` still means live rows, `completed` still
narrows, `limit` still caps, and the cursor still means "rows older than this".
There is no combination of parameters that means something different because `q`
is in the URL.

### The query

After `requireAuth`, with `q` present:

```sql
SELECT * FROM todos
 WHERE user_id = $1
   AND deleted_at IS NULL                                   -- or IS NOT NULL when deleted=true
   AND to_tsvector('english', title) @@ plainto_tsquery('english', $2)
   [AND created_at < $cursor]
   [AND completed = $x]
 ORDER BY created_at DESC
 LIMIT $limit + 1;
```

In Drizzle this is one more condition pushed onto the existing `conditions`
array:

```ts
if (q !== undefined) {
  conditions.push(sql`to_tsvector('english', ${todos.title}) @@ plainto_tsquery('english', ${q})`);
}
```

Three details in that line are load-bearing:

1. **The configuration is named (`'english'`), never defaulted.** The one-argument
   `to_tsvector(text)` reads `default_text_search_config`, a per-database GUC that
   can differ between a developer's container, the testcontainer, staging and
   production — so the same query could stem differently in each. It is also only
   `STABLE`, not `IMMUTABLE`, which means an expression index over it is not even
   creatable. Naming the configuration fixes both, and is what makes the future
   index a drop-in (see below).
2. **`plainto_tsquery`, not `to_tsquery`.** `to_tsquery` parses operators and
   raises a syntax error on arbitrary input, so a user typing `a & | b` would turn
   into a `500`. `plainto_tsquery` treats the whole string as words ANDed
   together and cannot fail on any input. `q` is user text arriving over HTTP;
   the function that reads it must not have a syntax.
3. **The value is a bound parameter.** Drizzle's `sql` template parameterises
   `${q}`; the string is never concatenated into SQL. This is a filter over user
   text and it is the one place in this feature an injection would live.

**Stop words return nothing, and that is the behaviour, not a bug.**
`plainto_tsquery('english', 'the')` produces an empty `tsquery`, and
`tsvector @@ ''::tsquery` is false — so a search for only stop words returns an
empty page rather than every row. It has its own acceptance criterion so the
alternative (an empty `tsquery` silently degrading to "no filter", which would
return the user's whole list and look like a broken search) cannot be shipped by
accident.

**Stemming is why `'english'` and not `'simple'`.** `'english'` reduces `buying`,
`buys` and `bought` to `buy`, so a search finds the todo the user actually wrote
rather than the exact form they happen to retype. `'simple'` would match only
identical words, which for a to-do list — where titles are imperatives and users
retype them from memory — is noticeably worse. The costs are accepted and stated:
English stop words are unsearchable (above), and a title written in another
language gets English stemming, which for unrecognised words is a no-op and so is
harmless rather than wrong.

### Data model changes

**None. No migration, no column, no index.** `drizzle/` is untouched and so is
`src/db/schema.ts`. There is no expand step and therefore no contract step.

This contradicts the backlog entry's `migration` risk tag, which was written
before the design existed, and it sits close to a convention in `AGENTS.md`
("every new query path needs a supporting index in the same migration"), so it is
argued in full here and recorded in
[ADR 0023](../../docs/adr/0023-full-text-search-without-a-new-index.md). It is
the line to reject this spec on if you are going to reject it on one.

**Why no index is required for correctness.** The access path is unchanged. Every
search is already scoped to one account, so
`todos_user_id_created_at_idx (user_id, created_at DESC)` from `0001_init.sql`
drives the scan exactly as it does for a plain list: Postgres walks that user's
rows newest-first and stops as soon as it has `limit + 1` matches. The text
predicate is a filter over rows the index has already narrowed to one user — it
is not what finds the rows. This is the same argument F-010 made for
`deleted_at`, and it is recorded in ADR 0016.

**Why no index is possible today, even if it were wanted.**
`scripts/ci/migration-safety.mjs` fails any migration containing `CREATE INDEX`
without `CONCURRENTLY`, and `src/db/migrate.ts` runs every migration inside a
transaction, where Postgres refuses `CREATE INDEX CONCURRENTLY` — issue #11. A
migration-only PR does not help: the guard's rule does not depend on app code
being present. The only ways to an index are fixing #11 (a change to the
migration runner, with its own tests and its own failure modes — not this
feature) or weakening a guard, which `AGENTS.md` forbids outright. F-004, F-005,
F-009 and F-010 each routed around #11 the same way.

**Where the honest limit is.** The worst case is a search that matches nothing:
Postgres evaluates `to_tsvector` on every live row of that account before
returning an empty page. That is bounded by one user's row count, which nobody
can inflate but that user, one row per authenticated `POST`. At a thousand todos
it is a fraction of a millisecond of parsing per row; at a hundred thousand it is
not. The trigger for revisiting is written into the Observability section as a
number rather than a feeling, and the fix is already prepared: because the query
names the expression exactly, the day #11 is fixed the index is

```sql
CREATE INDEX CONCURRENTLY todos_title_fts_idx
    ON todos USING gin (to_tsvector('english', title))
 WHERE deleted_at IS NULL;
```

with **no application change at all**. That is the whole reason the design puts
the expression in the query instead of in a column.

**Rejected: a stored `tsvector` generated column.**
`ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', title)) STORED`
is the textbook shape and costs more here than it returns. It rewrites the whole
table under an `ACCESS EXCLUSIVE` lock (not the catalogue-only change F-010's
`deleted_at` was), it duplicates every title in a second column forever, it is
useless without the GIN index that issue #11 blocks anyway, and it makes the
query name a column rather than an expression — so it must land _before_ the
application change, in its own PR, and it cannot be rolled back without a
destructive migration. The expression form costs nothing, is identical in
behaviour today, and upgrades to the indexed form without touching `src/`.

**Rejected: `pg_trgm` and a GIN trigram index.** It buys substring and typo
tolerance, which is out of scope, needs `CREATE EXTENSION` plus an index, and is
blocked by #11 twice over.

**Rejected: a search service.** No new dependency is added — `package.json` has
none for this and needs none. Postgres' text search is already in the database
this application runs on, has no operational cost, no second store to keep in
sync, and no new failure mode. An external index for one text column of a
single-user-scoped table would be infrastructure bought to avoid a `WHERE`
clause.

### Key decisions

Two ADRs, one decision each:

- **[ADR 0022 · Search is a filter, not a ranking](../../docs/adr/0022-search-is-a-filter-not-a-ranking.md)**
  — search results are ordered by `created_at DESC` and paginate by the same
  keyset cursor as every other list.
- **[ADR 0023 · Full-text search without a new index](../../docs/adr/0023-full-text-search-without-a-new-index.md)**
  — the match is an in-query `tsvector` expression; no column, no index, no
  migration, and the stated condition under which that changes.

#### Ranking versus the cursor — the hardest question in this spec

The obvious design for search is "best match first": `ORDER BY ts_rank(...) DESC`.
It is rejected, and the reasoning matters more than the conclusion because it is
the decision a reviewer is most likely to want reversed.

**A relevance order cannot carry this application's cursor.** ADR 0002 defines a
cursor as the sort key of the last row returned, and the next page as the rows
whose sort key is strictly beyond it. That works because `created_at` is a stored,
monotonic, per-row value: the server can express "after this point" as a `WHERE`
clause and page without counting. `ts_rank` is none of those things. It is
computed per query, it is not stored, it is not unique — over one-line titles most
matches score identically — and "the rows ranked below this score" is not a
predicate that any index can satisfy. Forcing it into a keyset cursor would mean
encoding `(rank, created_at, id)` into an opaque token and re-deriving the rank
identically on the next request, which is a different pagination system, not a
parameter.

**So the real choice is between ranking with `OFFSET`, and recency without it.**
`OFFSET` is what search engines normally use and it is explicitly forbidden here:
`AGENTS.md` says "keyset only, never `OFFSET`", and ADR 0002 spells out why —
cost grows linearly with depth, and rows shift under a concurrent write so pages
drop or repeat entries. Giving one endpoint a second pagination system, with a
second set of cursor semantics for clients to learn and a second set of edge
cases for reviewers to hold in their heads, in exchange for ordering a result set
that is already scoped to one user, is a poor trade.

**And ranking buys very little on this data.** `ts_rank` scores a document by term
frequency and position. A todo title is at most 500 characters, usually five
words, and a term appears in it once. Nearly every match scores the same, so a
relevance sort would be an arbitrary order dressed up as a meaningful one — and
would then need `created_at` as a tie-break anyway. Recency is a real signal on a
to-do list: the todo a user is looking for is more often the recent one.

Consequences, stated plainly so nobody has to discover them:

- A user searching a common word gets their matches newest first, not "best"
  first. With `limit=20`, page one is the twenty most recent matches.
- If this application ever grows a long text body per todo, this decision should
  be revisited — that is the condition under which ranking starts to mean
  something. ADR 0022 names it.
- Reversing this later does not break anything shipped: adding relevance means a
  new endpoint with its own pagination contract, not a change to this one.

#### Why `q` on the list endpoint and not `GET /api/todos/search`

A separate endpoint would duplicate the limit validation, the cursor parsing, the
`completed` and `deleted` filters, the response schema, the cache decision and
the authorization predicate, to run a query that differs from the list by one
`AND`. Every future change to the list — the `(created_at, id)` composite cursor
from issue #29, for one — would then have to be made twice, and the second copy
is the one that gets forgotten. This is the same reasoning F-010 used when it
rejected `GET /api/todos/deleted` in favour of `?deleted=true`.

The cost is that one handler now serves two user intentions, and its `WHERE`
clause has four optional conditions. That is one array of conditions in one
place, which is the shape the handler already has.

#### Is the trash searchable? Yes — by the parameter that already exists

F-010 left this decision here explicitly ("F-013 has to decide explicitly whether
the trash is searchable at all"). The answer: **`q` composes with `deleted`, and
therefore the trash is searchable exactly when the caller asks for the trash.**

- `?q=x` (default `deleted=false`) searches **live todos only**. A deleted todo is
  never returned by a default search, which is the bug ADR 0016 predicted by name.
- `?q=x&deleted=true` searches **the trash only**.
- There is no mode that mixes them, exactly as there is no such mode for listing.

This is the option with the least new machinery: no third parameter, no
`searchDeleted` flag, no partial-versus-full index dilemma — because there is no
index. F-010 warned that a non-partial full-text index would match deleted titles;
that warning is answered by the predicate being in the query, at the call site, in
SQL, which is rule 1 of ADR 0016 and is already how the handler reads today.

Rejected: **search never sees the trash.** It would make the trash the one view in
the application you cannot search, and a user looking for something they might
have deleted is exactly the user who most needs to search. Rejected: **a
three-state `q` that searches both and marks each row.** Nobody asked for it, it
needs a merged ordering across two predicates, and `deletedAt` is already on every
row for a client that wants to build it.

#### Interaction with F-012's cache

**A request with `q` is never cached — not read from, not written to.** One clause
in the existing guard:

```ts
const cacheable = cache !== null && cursor === undefined && q === undefined;
```

Two reasons, in order of importance:

1. **Correctness first.** The cache field is
   `v1:{live|trash}:{any|done|open}:{limit}` (`cacheField` in
   `src/lib/todo-list-cache.ts`) and does not include `q`. If a search response
   were written under that field, the next plain list request for that user would
   be served the search result — a user's list silently truncated to their last
   query. Either `q` joins the field name or search bypasses the cache; there is
   no third option, and this spec picks the one that cannot be got wrong.
2. **A search cache would not earn its keep anyway.** The cached dimensions today
   have 600 reachable combinations and the store already caps a user's hash at 16
   fields, dropping it wholesale beyond that (ADR 0020's memory bound). `q` is
   free text: its cardinality is the number of distinct things a user types. Add
   it to the field name and searching would evict the plain list — the one
   variant that actually repeats — on the seventeenth distinct query, making the
   feature that exists to speed up the list the thing that empties its cache.

Nothing else about F-012 changes: invalidation is already whole-user (one `DEL`
per write, ADR 0020), so no new write path exists here to invalidate and no
stale-search state can exist. When `TODO_LIST_CACHE_ENABLED` is `false` or
`REDIS_URL` is empty — which is every environment today — this clause is dead
code that still deserves its test.

#### Interaction with keyset pagination

A search paginates exactly like a list, for the reason F-010 already wrote down:
the cursor is a _value_, not an offset and not a row reference, so narrowing the
result set does not move any remaining row relative to it. `created_at < $cursor`
never looks up the cursor row, so the cursor stays valid even if the row it came
from has since been edited so that it no longer matches `q`.

Two properties a reviewer should check rather than assume:

1. **The text predicate is in the `WHERE`, never a `.filter()` on the returned
   rows.** The handler fetches `limit + 1` _already-matching_ rows, so pages stay
   full and `nextCursor` stays correct. A post-fetch filter would return short
   pages with a non-null `nextCursor`. Same rule as the authorization one.
2. **A cursor is not scoped to a query.** Sending a cursor from one search to a
   different `q` is well-defined — "matching rows older than this instant" — and
   simply returns a different result set. There is no cursor forgery concern
   because a cursor is a timestamp, not a permission: it is still `AND`ed with
   `user_id = $caller`.

Issue #29 (the `created_at`-only cursor can skip a row under concurrent creation)
is inherited, not worsened: the composite `(created_at, id)` fix composes with an
extra `AND` in the same `WHERE` without interacting.

### Backlog split

The API fits in one PR (~260 hand-written lines; budget below), so the feature is
not split for size. It is split for surface, exactly as F-004/F-017,
F-009/F-020 and F-010/F-021 were: **this feature ships with no way to search from
a browser.** F-016's list screen keeps working unchanged and gains no search box,
so until the follow-up lands, search is reachable only by speaking HTTP.

**F-023 · Web UI — search the todo list** is added to `specs/features.yaml`,
`deps: [F-013, F-016]`, `risk_tags: [frontend]`, with a stub spec. It owns the
search input, the empty-result state, the interaction between searching and the
existing filters, and the Playwright journey. It inherits three constraints from
here: results are **newest first, not best first** (the screen must not imply
ranking); a search that matches nothing is a `200` with an empty list, not an
error; and a query of only stop words legitimately returns nothing, which the
copy has to survive.

**Notes for features that will read this design, not decisions for them:**

- **F-015 (account deletion and export)** — unaffected. Search adds no stored
  data, so there is nothing new to export or erase.
- **#11** — routed around for the fifth time. If a human ever fixes it, the index
  in "Data model changes" is a one-migration, zero-application-change follow-up,
  and this spec is where the exact statement is written down.

## Acceptance criteria

- [ ] `GET /api/todos?q=plumber` returns only the caller's todos whose title
      contains the word, and omits their other todos —
      `integration: search returns only matching todos`
- [ ] Search matches word forms, not exact strings: a todo titled `buying milk`
      is returned by `?q=buy` and by `?q=milk`, and a todo titled `call plumber`
      is not — `integration: search matches stemmed words`
- [ ] Search matches whole words only: a todo titled `groceries` is **not**
      returned by `?q=gro` — `integration: search does not match prefixes`
- [ ] A query matching nothing returns `200` with `items: []` and
      `nextCursor: null`, not a `404` — `integration: a search with no matches is an empty page`
- [ ] A query of only stop words (`?q=the`) returns `items: []` and **not** the
      caller's whole list — `integration: a stop-word-only query matches nothing`
- [ ] `?q=` and `?q=%20` return `400 validation_failed`, and a `q` of 101
      characters returns `400 validation_failed` —
      `integration: search rejects an empty or oversized query`
- [ ] `?q=` with characters that are `tsquery` operators (`a & b | c :* !`)
      returns `200`, never a `500` —
      `integration: search survives tsquery operator characters`
- [ ] A soft-deleted todo whose title matches is **not** returned by `?q=milk`,
      and **is** returned by `?q=milk&deleted=true`; a live matching todo is not
      in that trash result —
      `integration: search respects the deleted filter in both directions`
- [ ] `?q=` composes with `completed`: with one completed and one open matching
      todo, `?q=x&completed=true` returns only the completed one —
      `integration: search composes with the completed filter`
- [ ] With 3 matching todos and `limit=2`, `?q=x` returns 2 items and a non-null
      `nextCursor`; following that cursor returns the third with
      `nextCursor: null`, and no todo appears twice —
      `integration: search paginates by the same keyset cursor`
- [ ] Search results are ordered `created_at DESC`, asserted against three
      matching todos created in a known order —
      `integration: search returns newest first`
- [ ] **Bob's search never returns Alice's todos**: with Alice and Bob both
      owning a todo titled `plumber`, Bob's `?q=plumber` returns exactly his own
      row and his `?q=plumber&deleted=true` returns none of Alice's deleted
      matches — `integration: search never crosses accounts`
- [ ] `GET /api/todos?q=x` without a session returns `401` —
      `integration: search requires authentication`
- [ ] With the cache enabled, a request with `q` neither reads nor writes the
      cache: after a search, a plain `GET /api/todos` for the same user still
      returns the full list, and `todo_list_cache_operations_total` records no
      `get` or `set` for the search request —
      `integration: a search request bypasses the list cache`
- [ ] `/metrics` exposes `todo_search_total` with `outcome` covering `match` and
      `empty`, and `todo_search_duration_seconds` —
      `integration: exposes search counters`
- [ ] No log line produced by a search contains the query text or any todo title,
      asserted against a captured log stream via the `logStream` build option —
      `integration: search queries are never logged`
- [ ] `openapi.json` documents the `q` parameter on `GET /api/todos` —
      `npm run openapi:check` fails if the checked-in file is stale

## Test plan

| Layer       | Cases                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unit        | **None required**, the position F-003 and F-010 took for the same reason: the only pure logic is one zod field, and the behaviour under test is a `WHERE` clause — stemming, stop words and operator characters are Postgres' semantics, and a unit test that mocked them would assert the mock. The zod bounds are covered as `400`s through the route.                                                                                                                                                                                                                                                                                                                                                                    |
| integration | Extends `tests/integration/todos.test.ts`. **happy path** (create three todos, search, get the matching ones back) · **validation failure** (empty, whitespace-only, 101-character `q`) · **unauthenticated** (no cookie) · **other user's resource** (Bob's search over Alice's identical titles — the case that matters most, live and trash) · stemming · no prefix match · empty result · stop-word-only query · `tsquery` operator characters · composition with `completed` and with `deleted` in both directions · keyset pagination across a search · ordering · counters · a log-stream scan. The cache-bypass case belongs in `tests/integration/todo-list-cache.test.ts`, next to the other `CACHE_ON` contexts. |
| e2e         | **None, deliberately.** There is no browser surface until F-023, so an e2e here would be `request.get()` calls duplicating the integration suite at the cost of a container boot — the argument F-004, F-008, F-009 and F-010 each made. F-016's existing journey must still pass unchanged, which is the real assertion this feature needs: a list request without `q` behaves identically.                                                                                                                                                                                                                                                                                                                                |
| load        | **No new k6 scenario, and no threshold change** — with one caveat stated rather than hidden. `load/smoke.js` registers a fresh account per iteration and creates two todos, so a search there would measure the two-row case and prove nothing about the scan this feature's risk tag is about. A scenario that proved anything would have to seed thousands of rows per virtual user, which is a different kind of test than a smoke run. The scan bound is instead handled by `todo_search_duration_seconds` in production, with the threshold written into "Observability" as a number.                                                                                                                                  |

## Security considerations

**Cross-account isolation, on a surface that reads across the table by content.**
This is the first query in the application whose predicate is about _what a todo
says_ rather than _which row it is_, which makes it the first one where a missing
`user_id` would return other people's data rather than an error. The mitigation is
the existing one and it is not weakened: `eq(todos.userId, userId)` is the first
condition in the same `conditions` array, in SQL, and nothing is fetched then
filtered in application code. There is no "search all todos" code path to guard,
because the handler has only one query. This has its own named acceptance
criterion (`search never crosses accounts`), covering both the live and the trash
mode, and it is the last criterion to cut if the diff runs over — which is to say,
it is not to be cut.

**Search is not an existence oracle for other accounts.** A query that matches
nothing and a query whose only matches belong to someone else return the identical
response: `200` with an empty list. Result counts, timings, and status codes are
all the same, so there is no way to learn from this endpoint that another user
wrote a given word.

**SQL injection is the obvious threat and is closed by parameterisation, not by
escaping.** `q` is interpolated through Drizzle's `sql` template, which binds it
as a parameter; it is never concatenated into the statement. The second-order
concern is `tsquery` _syntax_ injection — `to_tsquery` would raise on `a & | b`,
turning user input into a `500` and a stack trace in the logs.
`plainto_tsquery` has no syntax to inject: every input is a bag of words. There is
one acceptance criterion for exactly this input.

**Denial of service is bounded by the attacker's own data.** The worst case is a
non-matching search scanning every live row of the caller's account. Three bounds
apply, and they are the reason no per-route rate limit is added: an attacker can
only inflate their own row count, one row per authenticated `POST /api/todos`,
which the global limiter already caps; `q` is capped at 100 characters so the
`tsquery` itself is small; and the global limiter keys on
`request.user?.id ?? request.ip`, so search shares the account's existing budget
at `RATE_LIMIT_MAX` and inherits F-011's distributed counting. A per-route
override is not even expressible without splitting search onto its own route,
which "Key decisions" rejects for stronger reasons. If
`todo_search_duration_seconds` says this is wrong, the fix is the index in "Data
model changes", not a new limit bucket.

**The query string is user content and is never logged.** `q` is text a user
typed — plausibly the same category of content as a todo title, and sometimes
more revealing, since it says what they were looking for. It is not logged, not
put in a metric label, and not attached to a span attribute. Note that
`http_request_duration_seconds` labels on the _route pattern_ (`/api/todos`),
never the URL, so the query string does not leak into metrics through the
existing hook either. A log-stream assertion keeps it that way, mirroring F-010's.

**No new PII category and no new storage.** Nothing is stored, cached, or copied
by this feature — the title stays in the one column it already occupies, search
results bypass Redis entirely (see "Interaction with F-012's cache"), and the
query text exists only for the duration of one request.

**CSRF and authentication.** Unchanged: `GET /api/todos` is a safe method behind
`requireAuth`, and `q` adds no state change.

## Observability

- **`todo_search_total{outcome="match"|"empty"}`** — a new Prometheus counter in
  `src/plugins/metrics.ts`, passed into `registerTodoRoutes` the way
  `todosSoftDeleted` already is, incremented only when `q` is present. No query
  text as a label: it is user content and unbounded cardinality, which are two
  independent reasons. The reading that matters is the **ratio**: `empty`
  dominating `match` means users are not finding things — either the feature is
  not doing what they expect (stemming, prefix matching) or it is being used as a
  prefix search, which it is not. It is also the worst-case latency path, so a
  rising `empty` rate and a rising duration are the same story.
- **`todo_search_duration_seconds`** — a histogram around the search query alone,
  not the whole request, because the whole request is already measured by
  `http_request_duration_seconds` and that series **cannot** answer this
  feature's question: it labels by route pattern, so a search and a plain list are
  indistinguishable in it. Buckets follow the existing HTTP histogram's shape.
  **This is the series that decides whether the no-index decision was right**, and
  it comes with a number rather than a feeling: **if `p95` exceeds 100 ms, or
  `p99` exceeds 250 ms, over a day, the unindexed scan has outgrown the data and
  the GIN index in "Data model changes" is the fix** — one migration, no
  application change, gated on issue #11.
- **One structured log line per search** — `request.log.info({ search: { outcome:
'match' | 'empty', count } })`. The outcome and the number of rows returned,
  never the query and never a title. This is what turns "search is slow" into "for
  which shape of query" without ever writing down what anyone searched for.
- **Not measured:** rows scanned per search. It is the number that would most
  directly prove the cost, and Postgres will not give it to the application
  without `EXPLAIN` on every query. The duration histogram is its observable
  proxy.

## Rollout

**No feature flag and no configuration.** One optional query parameter ships on in
every environment, so the deployed contract matches `openapi.json` everywhere —
the position F-003, F-004, F-009 and F-010 all took. A flag here would gate a
parameter that does nothing unless a client sends it; absence of the parameter is
already the off switch, and no shipped client sends it until F-023.

**Order.** Merge. No migration, so nothing runs at container start and
`scripts/docker-entrypoint.sh` is unaffected.

**During the rolling deploy, both versions are correct.** An old instance receiving
`?q=x` ignores an unknown query parameter and returns the unfiltered list; a new
instance filters. The only visible effect is that a search issued mid-deploy may
come back unfiltered — a superset of the right answer, never another user's rows,
never an error — and it stops the moment the rollout finishes. Nothing is written,
so nothing is left inconsistent.

**Rollback at 2am.** Redeploy the previous image. There is nothing else to undo:
no migration to reverse, no column to leave behind, no cache entry to purge (search
responses are never cached), no flag to flip, no data written. The feature's entire
footprint is one `WHERE` condition and two metrics, and the endpoint without them
is the endpoint that shipped in F-003. This is the cheapest rollback of any feature
in this backlog, and that is a direct consequence of the no-migration decision.

**What to watch after enabling, in order:**

1. `todo_search_duration_seconds` p95 and p99 against the thresholds above — the
   no-index bet, checked rather than assumed.
2. `http_request_duration_seconds{route="/api/todos"}` p95 against its `< 200 ms`
   load threshold. Search and list share this series; a rise after F-023 puts real
   search traffic on it is the first place it shows up.
3. `todo_search_total{outcome="empty"}` as a fraction of the total. A high steady
   ratio is a product signal (users expect prefix matching) and a performance one
   (empty searches are the full-scan case) at the same time.
4. `todo_list_cache_operations_total` hit ratio — it must not _fall_ when search
   traffic arrives. If it does, `q` is reaching the cache and the bypass is broken.

**Follow-ups this creates:**

- **F-023** — the browser search box (added by this plan). Until it ships, this
  feature has no user-facing surface.
- **#11** — the `CREATE INDEX CONCURRENTLY` conflict, routed around again. The
  exact index statement and the metric threshold that would justify it are both
  written down above, so the follow-up is a copy-paste rather than a redesign.
- **#29** — unfixed and unaffected; the composite-cursor fix must keep the new
  `AND`, the same way it must keep F-010's.

**Diff budget.** Estimated ~260 hand-written lines: `src/routes/todos.ts` (~30:
one zod field, one condition, the cacheable clause, the counters and the log
line), `src/plugins/metrics.ts` and `src/app.ts` (~20), integration tests (~200,
including the cache-bypass case in its own file), plus a regenerated
`openapi.json` (generated, excluded). Comfortably inside the ~500 guidance, which
is why the API is one PR — and F-023 exists rather than a search box in this one.
If it runs over, cut the ordering case and the stemming case; **never** the
cross-account case, the `deleted` composition case, or the cache-bypass case,
which are this feature's security and correctness properties.
