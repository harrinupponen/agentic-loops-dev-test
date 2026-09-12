# 23. Full-text search without a new index

Date: 2026-09-12
Status: Accepted

## Context

F-013 matches todos by words in the title. The textbook implementation is a
stored `tsvector` column, or an expression index, with a GIN index over it — and
`AGENTS.md` says "every new query path needs a supporting index in the same
migration". This ADR exists because F-013 ships neither, and that needs to be a
recorded decision rather than an omission a reviewer discovers.

Three facts constrain the choice.

**Local constraint.** `scripts/ci/migration-safety.mjs` rejects any migration
containing `CREATE INDEX` without `CONCURRENTLY`, and `src/db/migrate.ts` runs
every migration inside a transaction, where Postgres refuses
`CREATE INDEX CONCURRENTLY`. That is issue #11, open since F-004, routed around by
F-004, F-005, F-009 and F-010. A migration-only PR does not escape it: the guard's
rule does not depend on application code being present. The only legitimate routes
to an index are fixing the migration runner — a change with its own failure modes,
belonging to its own feature — or weakening a guard, which `AGENTS.md` forbids
outright.

**Access path.** Every query in this application is scoped to one account. A
search is `WHERE user_id = $1 AND deleted_at IS NULL AND <text match> ORDER BY
created_at DESC LIMIT n+1`, and `todos_user_id_created_at_idx (user_id, created_at
DESC)` from `0001_init.sql` drives it exactly as it drives a plain list: Postgres
walks that user's rows newest-first and stops once it has enough matches. The text
predicate filters rows the index has already narrowed to one user; it is not what
finds them. This is the same argument ADR 0016 made for `deleted_at`.

**Scale.** The worst case — a search matching nothing — evaluates `to_tsvector`
over every live row of one account. The bound is one user's row count, and only
that user can grow it, one row per authenticated `POST`. At a thousand todos this
is sub-millisecond parsing; at a hundred thousand it is not.

## Decision

F-013 adds **no column, no index, and no migration**. The match is an expression
evaluated in the query:

```sql
to_tsvector('english', title) @@ plainto_tsquery('english', $q)
```

Three rules come with it.

1. **The text search configuration is always named explicitly.** Never the
   one-argument `to_tsvector(title)`, which reads the `default_text_search_config`
   GUC — it can differ between a developer's container, the testcontainer,
   staging and production, so the same query would stem differently in each, and
   it is only `STABLE`, which makes an expression index over it uncreatable.
2. **The expression in the query is the expression a future index will use**,
   character for character. That is the whole reason it lives in the query rather
   than in a generated column: when issue #11 is fixed, the index is

   ```sql
   CREATE INDEX CONCURRENTLY todos_title_fts_idx
       ON todos USING gin (to_tsvector('english', title))
    WHERE deleted_at IS NULL;
   ```

   with **zero application change** — one migration-only PR, and the planner of
   that PR does not have to rediscover any of this.

3. **The bet is instrumented, not assumed.** `todo_search_duration_seconds`
   measures the search query alone (the existing HTTP histogram labels by route
   pattern and so cannot tell a search from a list). The trigger is a number: if
   p95 exceeds 100 ms or p99 exceeds 250 ms over a day, the unindexed scan has
   outgrown the data and rule 2 is the fix.

## Consequences

F-013 has the smallest footprint of any feature in this backlog: one `WHERE`
condition and two metrics. No expand step, no contract step, no lock, no backfill,
nothing to leave applied after a rollback, and a 2am rollback that is a redeploy
with nothing else to undo.

The cost is a latency risk carried in production rather than eliminated in
advance, on a path whose worst case grows with a single account's row count. That
is an acceptable trade **only because it is measured**; without the histogram this
decision would be a guess. It is also worth being precise about what the future
index does and does not buy: a GIN index over the expression removes the per-row
`to_tsvector` cost, but the ordering is still `created_at DESC`, which GIN cannot
provide — so the win is on the non-matching and rarely-matching queries, which is
exactly the worst case identified above.

Rejected, for the record. A **stored generated `tsvector` column** rewrites the
whole table under an `ACCESS EXCLUSIVE` lock (unlike F-010's catalogue-only
`ADD COLUMN`), duplicates every title forever, is useless without the GIN index
issue #11 blocks anyway, and makes the query name a column — so it would have to
land in a separate, earlier PR and could not be rolled back without a destructive
migration. **`pg_trgm`** buys substring and typo tolerance that nobody asked for,
and needs an extension plus an index. **An external search service** adds a
dependency, a second store to keep in sync, and a new failure mode, to avoid a
`WHERE` clause over one text column of a table that is always queried by one
user's id.

This ADR governs `todos.title`. A second searchable field, or a text body longer
than a title, invalidates the scale argument above and not merely the
implementation — it should reopen this decision and ADR 0022 together.
