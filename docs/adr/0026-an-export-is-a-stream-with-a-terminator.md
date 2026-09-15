# 26. A data export is a stream with a terminator, not a document

Date: 2026-09-15
Status: Accepted

## Context

F-015 has to hand a user everything this application stores about them, in one
request. The obvious implementation is the one every tutorial writes: `SELECT *`
from each table, assemble one JSON object, return it, let the serializer write it
out.

Three properties of this codebase make that a way to take the service down, and
all three are already written into the configuration rather than hypothetical:

1. **Nothing caps how many todos an account may have.** There is no per-account
   limit anywhere in `src/routes/todos.ts`, and there is no reason to add one for
   this feature's benefit.
2. **`JSON.stringify` is synchronous and `@fastify/under-pressure` is configured
   with `maxEventLoopDelay: 1_000`** in `src/app.ts`. Serialising a large object
   blocks the event loop, and a blocked event loop is `503`s for every other
   request on that instance. One authenticated user should not be able to shed
   load for everybody.
3. **`src/db/client.ts` sets `statement_timeout` and `query_timeout` to 10
   seconds, over a pool of `DATABASE_POOL_MAX` (10) connections.** A single
   unbounded `SELECT` dies at an arbitrary account size and gives the user a `500`
   that every retry reproduces, and anything holding a connection for the length
   of a download hands a tenth of the instance's database capacity to a client's
   bandwidth.

The mechanism most applications reach for instead — generate the export
asynchronously, store the artefact, email a signed link — needs three components
this project does not have and has decided not to have. There is no scheduler,
queue or worker anywhere (ADR 0017 is the standing decision not to add one, and it
names F-015's export artefacts as a case it expected to arrive). There is nowhere
to put a multi-megabyte file: `docs/deployment-sevalla.md` provisions two Postgres
databases and nothing else. And there is no mail transport that sends anything
until F-018 ships — `MAIL_TRANSPORT=drop` in production. It would also create a new
security surface, a URL that grants a full copy of an account to whoever holds it,
which is a larger decision than the feature that would introduce it.

## Decision

**An export is a bounded stream of lines, and its last line says it finished.**

1. **Newline-delimited JSON** (`application/x-ndjson`), one object per line, each
   line carrying a `type`. The response is a `Readable`; the handler never holds
   the document.
2. **Rows are read in keyset batches** — 500, a constant in the module, not
   configuration — over indexes that already exist. Each batch is its own
   statement that returns promptly and releases its connection, and each row is
   written as a line and dropped. Memory is O(batch), not O(account), and the
   event loop yields between batches.
3. **No snapshot transaction.** Not `REPEATABLE READ`, not any transaction
   spanning the stream. A transaction stays open for as long as the slowest client
   takes to read, pinning a pool connection and holding back vacuum across the
   whole database for that time. A client's bandwidth must not be able to affect
   the database's ability to reclaim dead tuples.
4. **The last line is a terminator carrying per-section counts.** A document whose
   last line is not `{"type":"end",…}` is incomplete and must be discarded by
   whoever reads it.
5. **No new dependency** to achieve any of the above. No `pg-query-stream`, no
   JSON-streaming library, no archive format.

## Consequences

**A failure after the first byte cannot be reported.** The status line is already
`200` and the headers are gone; a batch query that throws can only destroy the
stream. This is the honest cost of streaming and it has exactly two mitigations,
both required rather than optional: the terminator, which is how a consumer knows,
and `account_exports_total{outcome}` counting `started` and `completed`
separately, whose difference is the number of exports that died mid-flight. That
counter is to this feature what `audit_write_failures_total` is to F-014.

**The document is not a point-in-time snapshot.** Sections are separate statements,
so a todo created while the stream runs may or may not appear, and one deleted
while it runs may vanish between sections. `exportedAt` is the time the export
started and is the only consistency claim made. For a personal data export this is
an acceptable inaccuracy — the alternative trades a second of staleness for a
class of database-wide operational problem.

**The response is not valid JSON**, and `JSON.parse` on the whole file fails.
Consumers read it line by line. This is stated in the OpenAPI description, implied
by the content type, and visible in the `.ndjson` filename. The gain is that the
same format is readable by `jq`, by `wc -l`, by a spreadsheet importer and by a
five-line script, and that a partial file is still readable up to the point it
stopped.

**Adding a table to a future export is one more section**, a loop and a mapper,
with no change to the transport, the framing, or anything already written. Adding
an asynchronous pipeline later — if an export ever legitimately needs minutes
rather than seconds — means superseding this ADR, and by then a scheduler, an
object store and a mail transport would each be a decision someone has made on
purpose rather than three components smuggled in behind one feature.

If this application ever acquires an export that cannot be produced within a
request — a table whose per-account volume is genuinely unbounded in bytes rather
than rows, or an obligation to include artefacts that are not rows — this ADR is
what has to change first, and superseding it is the intended path.
