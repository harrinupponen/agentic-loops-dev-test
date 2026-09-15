# 27. An export contains what the user gave us, never what protects it

Date: 2026-09-15
Status: Accepted

## Context

"Export everything we hold about this user" sounds like a complete instruction. It
is not, and the gap is where the mistakes live.

Taken literally it includes `users.password_hash`, because that row is about the
user. It includes `sessions.id`, which is `sha256(token)` — the verifier for a live
credential that ADR 0014 added `public_id` specifically to avoid handing out. It
includes both recovery-token tables, which hold token hashes. Each of those is
data about the user in the trivial sense and a credential in every sense that
matters, and every one of them would end up in a file that the user then stores in
a downloads folder, copies to a cloud drive and emails to themselves.

Taken loosely, the opposite failure appears: somebody decides `idempotency_keys`
is "infrastructure" and skips it without noticing that `response_body` is a jsonb
copy of the user's own todo. The judgement that produced the right answer there is
not recorded anywhere, so the next table is judged from scratch by someone else.

The third failure is the slow one. An export written today covers the seven tables
that exist today. A migration in six months adds an eighth, nobody remembers that
an export exists, and the export silently becomes incomplete — which is worse than
never having had one, because a user who has been given a complete-looking file
has no way to know that it is not.

## Decision

**The export is an allowlist, every table is named, and credentials are refused
categorically.**

1. **A table is either exported or refused, by name, in the spec.** There is no
   third state. The list in F-015's "What is exported, and what is refused" covers
   every table in `src/db/schema.ts`, with a reason on each line.
2. **A migration that adds a table owes the next planner a line in that list.** A
   table with no verdict is an unfinished export, and the correct place to notice
   it is a spec review, not a subject access request.
3. **Nothing that authenticates or verifies anybody is ever exported.** Password
   hashes, session token hashes, reset token hashes, verification token hashes.
   This is categorical and needs no per-case argument: a credential verifier is
   not portable to anywhere, tells the user nothing they do not already know, and
   is an offline attack target the moment it leaves the server.
4. **Columns are projected explicitly, never `select()`ed wholesale, and mapped by
   a pure function per type.** This is what makes rule 3 mechanical rather than
   careful: a column added to a table in a future migration cannot appear in an
   export by accident, because nothing reads a whole row and nothing spreads one
   into a line.

## Consequences

The export is describable in a table a reviewer can check against
`src/db/schema.ts` in a minute, and the security claim — no credential leaves in
this file — is verifiable from the column projections rather than from a promise.
The pure mappers make it unit-testable, which is unusual for this application's
server features and is the reason F-015 has unit tests at all.

**Something a user might reasonably expect is deliberately missing**, and pretending
otherwise would be the failure this ADR exists to prevent. A pending password reset
does not appear in an export, because the only thing in that row is a hash and an
expiry; the _event_ appears instead, because F-014 records
`password_reset.requested` in a form that outlives the token. The 24-hour cache of a
client's own idempotent retries does not appear, because every byte of it duplicates
a `todos` row the export already contains in full and in its current state.

Rule 2 is an obligation on people who are not reading this file at the time, which
is the weakest kind of rule. It is written down anyway because the alternative is
nothing, and because the cost of noticing late is a user who has been handed an
incomplete file and told it was everything. The stronger enforcement — a test that
enumerates `information_schema.tables` and fails when a table has no verdict — is
deliberately not built now: it would be a guard asserting against a hand-maintained
list, which is the same list, checked twice. If a second table is ever missed, build
it then and supersede this paragraph.

What is _not_ claimed: that the export is complete in the legal sense. It contains
every table this application writes. Logs, metrics, traces, backups and whatever a
platform provider retains are outside it, and outside this application's reach.
