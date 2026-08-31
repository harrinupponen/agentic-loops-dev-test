# F-003 · Todo CRUD with keyset pagination

## Problem

A signed-in user has no way to record, review, complete, or remove their tasks.
This is the core of the product and every later feature builds on it.

## Scope

**In scope**

- Create, read, update, delete a todo owned by the requesting user
- List a user's todos, newest first, with cursor pagination and a completed filter

**Out of scope**

- Sharing, collaboration, or any todo visible to more than one user
- Due dates, tags, ordering, subtasks, attachments
- Soft delete (F-010), search (F-013)

## Design

### API changes

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/api/todos` | session | `?limit=1..100&cursor=<ISO date>&completed=true\|false` |
| POST | `/api/todos` | session | `{ title }`, 1–500 chars, trimmed |
| GET | `/api/todos/:id` | session | 404 if not owned |
| PATCH | `/api/todos/:id` | session | `{ title?, completed? }`, at least one required |
| DELETE | `/api/todos/:id` | session | 204 on success |

### Data model changes

`todos (id uuid pk, user_id uuid fk→users cascade, title text, completed bool
default false, created_at timestamptz, updated_at timestamptz)` plus
`todos_user_id_created_at_idx (user_id, created_at DESC)`.

Additive only; introduced in `0001_init.sql` with the rest of the schema.

### Key decisions

**Keyset pagination, not OFFSET.** `OFFSET n` makes Postgres walk and discard n
rows, so page 500 costs 500× page 1. The cursor is `created_at` of the last row
returned, and the composite index makes every page a bounded index scan. See
`docs/adr/0002-keyset-pagination.md`.

**404 for another user's todo, not 403.** A 403 confirms the id exists, which
leaks the existence of other users' records to anyone enumerating uuids.

## Acceptance criteria

- [x] A user can create a todo and receives it back with `201` and a generated id
- [x] A user can list only their own todos
- [x] A user can update the title and completion state independently
- [x] A user can delete a todo, and a subsequent read returns 404
- [x] All five endpoints return 401 when unauthenticated
- [x] Requesting another user's todo by id returns 404, not 403
- [x] Listing supports `limit` and returns `nextCursor` when more rows exist
- [x] A title over 500 characters or empty after trimming returns 400
- [x] A PATCH with an empty body returns 400

## Test plan

| Layer | Cases |
| --- | --- |
| unit | none required — no pure logic beyond schema validation |
| integration | full CRUD round trip · all endpoints unauthenticated · cross-user isolation · pagination cursor stability · oversized title · empty patch |
| e2e | register → create → list → complete → delete → logout |
| load | `p(95) < 200ms` on list, `< 300ms` on create at 20 VUs |

## Security considerations

Every query filters on `user_id` in SQL rather than checking ownership after
fetching. Titles are stored raw and escaped at render time; there is no HTML
context on the API side. The global rate limit applies; no endpoint here is more
expensive than the others, so no per-route override.

## Observability

`http_request_duration_seconds{route="/api/todos"}` gives request rate, error
rate, and latency for the hot path. A p95 regression on list is almost always a
missing index or an N+1.

## Rollout

No flag needed — new endpoints, no existing behaviour changed. Rollback is a
redeploy of the previous image; the table can stay.
