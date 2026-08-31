# 2. Keyset pagination, never OFFSET

Date: 2026-08-29
Status: Accepted

## Context

Every list endpoint needs pagination. `LIMIT n OFFSET m` is the obvious choice
and the wrong one: Postgres must walk and discard all `m` preceding rows, so cost
grows linearly with depth. Page 500 costs 500× page 1. It also drops or repeats
rows when the underlying data changes between requests, because the window is
positional rather than anchored to a row.

## Decision

All list endpoints paginate by keyset. The cursor is the sort key of the last row
returned — `created_at` for todos — and the query becomes
`WHERE user_id = $1 AND created_at < $cursor ORDER BY created_at DESC LIMIT n`.

Every paginated query requires a composite index matching its filter and sort:
`(user_id, created_at DESC)`.

Endpoints fetch `limit + 1` rows and use the extra row's presence to compute
`nextCursor`, avoiding a second `COUNT` query.

## Consequences

Every page is a bounded index scan regardless of depth, and results stay stable
under concurrent writes.

The cost: no random access to page N, and the sort key must be unique enough to
avoid ties. `created_at` at microsecond resolution is adequate here; if ties
appear, the cursor becomes `(created_at, id)` and the index gains `id`.

Total counts, if ever needed, require a separate estimate rather than falling out
of the pagination query.
