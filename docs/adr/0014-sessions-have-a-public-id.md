# 14. A session is addressed by a surrogate id, never by its token hash

Date: 2026-09-11
Status: Accepted

## Context

`sessions.id` is `sha256(token)` (ADR 0004). It is the primary key, and it is a
verifier: anyone holding it can confirm a candidate session token offline. That
was fine while the table was only ever read by the session loader.

F-009 makes a session a resource a user can see and act on. That needs a name for
it — in a `DELETE` path, in a response body, and eventually in the browser DOM.
F-014 (audit log) needs the same name, and needs it to remain meaningful after
the session row is gone.

The tempting answer is to use the primary key that already exists. It costs no
migration.

## Decision

`sessions` gains `public_id uuid`, defaulted to `gen_random_uuid()`, and that is
the only session identifier that ever leaves the server.

Three rules follow:

1. **`sessions.id` is never serialised into any response, log line, span
   attribute, or metric label.** It may be selected — F-009 compares it to
   `request.sessionId` to mark the caller's own session — but the declared zod
   response schema, which strips undeclared keys, is what mechanically keeps it
   out of the body.
2. **Every lookup by `public_id` is scoped by `user_id` in the same `WHERE`
   clause**, so the uuid is an identifier and never an authorization token. This
   is AGENTS.md's rule; it also means `public_id` needs no unique index, because
   the existing `sessions_user_id_idx` already reduces the scan to one account's
   rows and a collision inside one account is both astronomically unlikely and
   harmless.
3. **Anything derived from a credential stays server-side.** A future table that
   keys on a hashed secret gets a surrogate id at the same time, not later.

## Alternatives rejected

**Return `sessions.id` as the session's id.** Zero migration, and it puts a value
derived from a live session token into a response body, a `DELETE` path, the
access log, the browser history, and any `Referer` a page leaks. F-004 already
refused to put a reset token in a query string for these reasons; the hash is a
weaker version of the same object, not a different kind of thing.

**Expose `sha256(sessions.id)` — hash the hash.** No column, no migration, no
backfill. Rejected because the public name stays a deterministic function of the
secret, so a candidate token is still confirmable by anyone holding the list, and
because revocation becomes a `WHERE` on a computed expression that no index can
ever serve.

**Re-key the table: `id uuid` primary key, `token_hash text UNIQUE`.** The
cleanest end state, and four PRs of expand/contract on the one table every
authenticated request reads, with a window in which the session loader and the
migration disagree about what the primary key means. The surrogate column reaches
the same externally visible design without that risk.

## Consequences

One additive column, defaulted and backfilled in the same migration, with the
`SET NOT NULL` deferred to a contract PR because the guard forbids destructive
DDL alongside application code. Between the expand and the contract the database
allows a NULL that no code path can produce.

The `sessions` table now has two identifiers, and a reader has to know which is
which. The schema comment and this ADR are the mitigation; the naming (`id` is
the secret-derived one, `public_id` is the public one) is deliberately not
symmetric so the difference is visible at a glance.

F-014 can record `public_id` in an audit row that outlives the session, and F-015
can export it, neither of which would be acceptable with the hash.
