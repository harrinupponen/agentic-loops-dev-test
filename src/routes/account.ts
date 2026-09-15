import { and, asc, eq, gt, or, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { jsonSchemaTransform, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { Readable } from 'node:stream';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import { auditEvents, sessions, todos, users } from '../db/schema.js';
import { recordAuditEvent } from '../lib/audit.js';
import { requireAuth } from '../plugins/auth.js';
import type { Metrics } from '../plugins/metrics.js';

/**
 * Rows read per statement. A constant in the module, not configuration: it is
 * the mechanism ADR 0026 chose over one unbounded SELECT, and a knob on it is a
 * knob on whether a large account can block the event loop for everybody else.
 * Exported so the multi-batch test can seed exactly one row past a boundary.
 */
export const EXPORT_BATCH_SIZE = 500;

/**
 * A version marker, not an extensibility mechanism: it exists so a consumer —
 * or a human opening the file in two years — can tell what shape this is.
 */
export const EXPORT_FORMAT = 'agentic-todo.export.v1';

/**
 * Exports per hour, per account. Hard-coded rather than an environment
 * variable, the same call src/routes/auth.ts makes for its 60-second
 * per-account token cooldown: nobody needs six copies of their account in an
 * hour, and F-011 records that staging already overrides two other limits to
 * 100000 — this is the one endpoint where the limit is the mitigation.
 */
export const EXPORT_RATE_LIMIT_MAX = 5;

/**
 * No email address and no user id: a file named after its owner leaks that
 * owner to everything that lists a downloads directory.
 */
const EXPORT_FILENAME = 'agentic-todo-export.ndjson';

/**
 * ADR 0027's allowlist, in code rather than only in the spec. Every table in
 * src/db/schema.ts appears in exactly one of these two lists; a table with no
 * verdict is an unfinished export, and tests/unit/account-export.test.ts fails
 * the moment a migration adds one without a decision here.
 */
export const EXPORTED_TABLES = ['users', 'todos', 'sessions', 'audit_events'] as const;

/** Refused by name, with the reason, so the next planner inherits the argument. */
export const REFUSED_TABLES = {
  password_reset_tokens:
    'A token hash and an expiry, live for at most 30 minutes. Exporting it hands out a ' +
    'second credential verifier in return for a fact the user already knows; F-014 records ' +
    'password_reset.requested in a form that outlives the token.',
  email_verification_tokens:
    'The same shape and the same refusal as the reset table: a credential verifier is not ' +
    'portable to anywhere and is an offline attack target the moment it leaves the server.',
  idempotency_keys:
    'Every byte of response_body duplicates a todos row this document already contains in ' +
    'full and in its current state, and the key and fingerprint are a 24-hour cache of the ' +
    "client's own retries. Refusing it removes no fact about the user.",
} as const;

/** A JSON value with no `undefined` in it, so every line round-trips. */
type Line = Record<string, unknown>;

/**
 * The keyset position of the last row written by a section.
 *
 * `createdAt` is the database's own text rendering of the timestamp, never a JS
 * Date, and that is load-bearing rather than fussy: Postgres keeps microseconds
 * and a Date keeps milliseconds, so a cursor built from one would be *earlier*
 * than the row it came from and the next batch would re-emit that row. The
 * round trip through text (which carries the offset) is exact; the round trip
 * through Date is not. Selected as an extra column per row and never written to
 * the document — the mappers name every key they emit.
 */
interface Cursor {
  createdAt: string;
  id: string;
}

type AccountRow = Pick<
  typeof users.$inferSelect,
  'id' | 'email' | 'emailVerifiedAt' | 'createdAt' | 'updatedAt'
>;
type TodoRow = Pick<
  typeof todos.$inferSelect,
  'id' | 'title' | 'completed' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;
type SessionRow = Pick<
  typeof sessions.$inferSelect,
  'publicId' | 'userAgent' | 'createdAt' | 'expiresAt'
>;
type AuditRow = Pick<typeof auditEvents.$inferSelect, 'id' | 'action' | 'outcome' | 'createdAt'>;

const iso = (value: Date) => value.toISOString();
const isoOrNull = (value: Date | null) => (value === null ? null : value.toISOString());

/**
 * The four row-to-line mappers, pure and exported for their own unit tests.
 *
 * They are the second half of ADR 0027 rule 4 — the first half is that every
 * query below projects named columns and nothing spreads a whole row — and
 * together they are what makes "a column added by a future migration cannot
 * appear in an export by accident" true rather than hoped for. Each one names
 * every key it emits; none of them takes a rest parameter or a spread.
 */
export function accountLine(row: AccountRow): Line {
  return {
    type: 'account',
    id: row.id,
    email: row.email,
    // The stored timestamp, not F-002's derived boolean: an export reports what
    // is stored, not what an API view shows. `password_hash` is not here and
    // never will be — see ADR 0027.
    emailVerifiedAt: isoOrNull(row.emailVerifiedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function todoLine(row: TodoRow): Line {
  return {
    type: 'todo',
    id: row.id,
    title: row.title,
    completed: row.completed,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    // Rows in F-010's 30-day trash are still held, so they are still exported.
    deletedAt: isoOrNull(row.deletedAt),
  };
}

export function sessionLine(row: SessionRow): Line {
  return {
    type: 'session',
    // `public_id`, exactly as F-009's list does. `sessions.id` is sha256(token)
    // and never leaves the server (ADR 0014).
    id: row.publicId,
    userAgent: row.userAgent,
    createdAt: iso(row.createdAt),
    expiresAt: iso(row.expiresAt),
  };
}

export function auditEventLine(row: AuditRow): Line {
  return {
    type: 'audit_event',
    id: row.id,
    action: row.action,
    outcome: row.outcome,
    createdAt: iso(row.createdAt),
  };
}

/**
 * One object, one line. JSON.stringify escapes every newline inside a string,
 * so a todo title containing one cannot become two lines of the document.
 */
export function encodeLine(value: Line): string {
  return JSON.stringify(value) + '\n';
}

type ExportMetrics = Pick<
  Metrics,
  | 'accountExports'
  | 'accountExportDuration'
  | 'auditEvents'
  | 'auditWriteFailures'
  | 'auditEventsPurged'
>;

const ErrorResponse = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  }),
  requestId: z.string(),
});

/**
 * The document, produced lazily.
 *
 * Every section is its own statement, scoped by `user_id` in the WHERE — never
 * a fetch followed by an ownership check — and paged by keyset over an index
 * that already exists, so memory is O(batch) rather than O(account) and the
 * event loop yields between batches (ADR 0026). There is no transaction around
 * this: one held open for as long as the slowest client takes to read would pin
 * a pool connection and hold back vacuum across the whole database, so the
 * accepted consequence is that the document is not a point-in-time snapshot and
 * `exportedAt` is the only consistency claim made.
 */
async function* exportDocument(
  request: FastifyRequest,
  db: Database,
  metrics: ExportMetrics,
  userId: string,
  startedAt: number,
): AsyncGenerator<string> {
  const counts = { todos: 0, sessions: 0, auditEvents: 0 };

  try {
    yield encodeLine({
      type: 'export',
      format: EXPORT_FORMAT,
      exportedAt: new Date(startedAt).toISOString(),
    });

    const account = await db
      .select({
        id: users.id,
        email: users.email,
        emailVerifiedAt: users.emailVerifiedAt,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    // Served by the primary key. The row exists — the session loader just read
    // it — but a deletion racing this request must not become a 500 on a
    // response whose status line is already 200.
    if (account[0]) yield encodeLine(accountLine(account[0]));

    // Forward scan of todos_user_id_created_at_idx. Includes the trash:
    // `deleted_at` is projected, not filtered on.
    yield* section(
      (cursor) =>
        db
          .select({
            id: todos.id,
            title: todos.title,
            completed: todos.completed,
            createdAt: todos.createdAt,
            updatedAt: todos.updatedAt,
            deletedAt: todos.deletedAt,
            cursorAt: exactly(todos.createdAt),
          })
          .from(todos)
          .where(and(eq(todos.userId, userId), after(todos.createdAt, todos.id, cursor)))
          .orderBy(asc(todos.createdAt), asc(todos.id))
          .limit(EXPORT_BATCH_SIZE),
      (row) => ({ createdAt: row.cursorAt, id: row.id }),
      todoLine,
      () => (counts.todos += 1),
    );

    // sessions_user_id_idx, then a sort of one account's rows — a set capped in
    // practice by SESSION_TTL_HOURS. Expired rows that have not been swept are
    // exported too: this is what is stored, not what F-009's list shows. The
    // keyset tie-break is `public_id`, never `id`, which is the token hash.
    yield* section(
      (cursor) =>
        db
          .select({
            publicId: sessions.publicId,
            userAgent: sessions.userAgent,
            createdAt: sessions.createdAt,
            expiresAt: sessions.expiresAt,
            cursorAt: exactly(sessions.createdAt),
          })
          .from(sessions)
          .where(
            and(eq(sessions.userId, userId), after(sessions.createdAt, sessions.publicId, cursor)),
          )
          .orderBy(asc(sessions.createdAt), asc(sessions.publicId))
          .limit(EXPORT_BATCH_SIZE),
      (row) => ({ createdAt: row.cursorAt, id: row.publicId }),
      sessionLine,
      () => (counts.sessions += 1),
    );

    // Forward scan of the (user_id, created_at, id) primary key F-014 created,
    // which is the same key its own read endpoint scans backward. Whether this
    // export's own account.exported row appears is a race the reader must not
    // assume either way; the next export will contain it.
    yield* section(
      (cursor) =>
        db
          .select({
            id: auditEvents.id,
            action: auditEvents.action,
            outcome: auditEvents.outcome,
            createdAt: auditEvents.createdAt,
            cursorAt: exactly(auditEvents.createdAt),
          })
          .from(auditEvents)
          .where(
            and(
              eq(auditEvents.userId, userId),
              after(auditEvents.createdAt, auditEvents.id, cursor),
            ),
          )
          .orderBy(asc(auditEvents.createdAt), asc(auditEvents.id))
          .limit(EXPORT_BATCH_SIZE),
      (row) => ({ createdAt: row.cursorAt, id: row.id }),
      auditEventLine,
      () => (counts.auditEvents += 1),
    );

    // The load-bearing line. A document whose last line is not this one is
    // incomplete and must be discarded by whoever reads it; the counts are
    // there so a consumer can check what it received rather than trust a byte
    // count.
    yield encodeLine({ type: 'end', counts });

    const seconds = (Date.now() - startedAt) / 1000;
    metrics.accountExports.inc({ outcome: 'completed' }, 1);
    metrics.accountExportDuration.observe(seconds);
    // Counts and a duration, never a title, an address or a user agent. This is
    // what makes "I downloaded my data and it looks empty" answerable without
    // touching the database.
    request.log.info(
      { export: { outcome: 'completed', ...counts, ms: Date.now() - startedAt } },
      'account exported',
    );
  } catch (err) {
    // The status line has been 200 since before the first byte, so nothing can
    // be reported in band: the only honest thing left is to destroy the stream,
    // which leaves the document without its terminator. `started` minus
    // `completed` is how many exports died this way, and `failed` separates
    // "the server broke" from "the client hung up" (ADR 0026).
    metrics.accountExports.inc({ outcome: 'failed' }, 1);
    request.log.error(
      { err, export: { outcome: 'failed', ...counts, ms: Date.now() - startedAt } },
      'account export failed',
    );
    throw err;
  }
}

/**
 * The timestamp as the database itself renders it, microseconds and offset
 * intact, projected alongside the row so the next batch can resume exactly
 * where this one stopped. See the note on `Cursor` for why the Date that is
 * already in the row will not do.
 */
const exactly = (column: AnyPgColumn) => sql<string>`${column}::text`;

/**
 * One section of the document, written one batch at a time and one line at a
 * time. Three sections share this loop rather than three copies of it, because
 * the property it carries — every row exactly once, no duplicate and no gap at
 * a batch boundary — is worth reviewing once.
 *
 * A batch shorter than the limit is the last one, which is the only place this
 * stops: an empty section costs exactly one statement.
 */
async function* section<Row>(
  read: (cursor: Cursor | undefined) => Promise<Row[]>,
  cursorOf: (row: Row) => Cursor,
  toLine: (row: Row) => Line,
  count: () => void,
): AsyncGenerator<string> {
  let cursor: Cursor | undefined;
  for (;;) {
    const batch = await read(cursor);
    for (const row of batch) {
      count();
      yield encodeLine(toLine(row));
    }
    if (batch.length < EXPORT_BATCH_SIZE) return;
    cursor = cursorOf(batch[batch.length - 1]!);
  }
}

/**
 * `(created_at, id) > (cursor.createdAt, cursor.id)`, spelled out because
 * Drizzle has no row-value comparison. `id` breaks ties, so the order is total
 * even when two rows share a timestamp and no row can be emitted twice or
 * skipped at a boundary. Undefined for the first batch.
 */
function after(
  createdAt: AnyPgColumn,
  id: AnyPgColumn,
  cursor: Cursor | undefined,
): SQL | undefined {
  if (!cursor) return undefined;
  // Cast back to timestamptz rather than compared as text: text ordering of a
  // timestamp is not timestamp ordering once an offset is involved.
  const at = sql`${cursor.createdAt}::timestamptz`;
  return or(gt(createdAt, at), and(eq(createdAt, at), gt(id, cursor.id)));
}

export function registerAccountRoutes(
  app: FastifyInstance,
  db: Database,
  metrics: ExportMetrics,
): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // Under the existing `auth` tag, in its own file: /api/auth/* is already
  // where everything about an account lives, and F-025's
  // DELETE /api/auth/account belongs beside this rather than appended to a
  // 580-line src/routes/auth.ts.
  //
  // 401 is deliberately not declared, matching the session and audit routes:
  // requireAuth raises it before validation, and no declared schema means no
  // serializer to strip the body.
  r.get(
    '/api/auth/export',
    {
      preValidation: requireAuth,
      config: {
        // Per account, because the global limiter's key generator is
        // `request.user?.id ?? request.ip` and the session loader runs at
        // onRequest, before this route-level hook.
        rateLimit: { max: EXPORT_RATE_LIMIT_MAX, timeWindow: '1 hour' },
        // The response is a stream of ndjson, which the zod transform cannot
        // describe: it converts every declared response to one JSON schema and
        // @fastify/swagger then publishes it under application/json. This route
        // documents its own 200 and leaves the 429 to the shared transform, so
        // openapi.json says what the endpoint actually serves for each status.
        swaggerTransform: (args) => {
          const result = jsonSchemaTransform(args);
          const schema = result.schema as { response?: Record<string, unknown> };
          if (schema.response) {
            schema.response['200'] = {
              description:
                'The account as newline-delimited JSON. Not a single JSON object: parse it ' +
                'line by line. A document whose last line is not {"type":"end",...} is ' +
                'truncated and must be discarded.',
              content: { 'application/x-ndjson': { schema: { type: 'string' } } },
            };
          }
          return result;
        },
      },
      schema: {
        tags: ['auth'],
        description:
          'Everything this application stores about the caller, as a streamed ' +
          '`application/x-ndjson` document: one object per line, each carrying a `type`, ' +
          'in the order export, account, todo, session, audit_event, end. Rows within a ' +
          'section are oldest first. The last line is `{"type":"end","counts":{...}}`; a ' +
          'document that does not end with it is incomplete and must be discarded, because ' +
          'a failure after the first byte cannot change a status line that is already 200. ' +
          'Soft-deleted todos are included with `deletedAt` set. Password hashes, session ' +
          'token hashes, recovery tokens and the idempotency cache are never included. ' +
          'Five requests per hour per account.',
        // Declared so a stale openapi.json fails `npm run openapi:check`. The
        // 200 is never serialised through this schema — Fastify sends a stream
        // untouched — and `swaggerTransform` above replaces it in the document.
        response: { 200: z.string(), 429: ErrorResponse },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const startedAt = Date.now();
      metrics.accountExports.inc({ outcome: 'started' }, 1);

      // Written before the first byte, not after the stream completes: the
      // security-relevant fact is "somebody asked for a complete copy of this
      // account", which is true whether or not the transfer finished, and after
      // the stream starts nothing can be reliably awaited. Awaited, caught and
      // never fatal (ADR 0024) — a failed audit write must not deny a user
      // their data.
      await recordAuditEvent(request, db, metrics, {
        userId,
        action: 'account.exported',
        outcome: 'success',
      });

      reply.header('content-type', 'application/x-ndjson');
      reply.header('content-disposition', `attachment; filename="${EXPORT_FILENAME}"`);
      // The single most sensitive response this application produces, and the
      // one most likely to sit in a shared cache, a proxy or a browser's
      // back-forward cache.
      reply.header('cache-control', 'no-store');

      // Fastify pipes a stream straight to the socket without serialising it,
      // so nothing here holds the document and JSON.stringify never sees an
      // object larger than one line. The cast is the price of declaring a 200
      // at all: the type provider derives the payload type from the response
      // schema, which describes the media type for openapi.json rather than a
      // value this route ever returns.
      const stream = Readable.from(exportDocument(request, db, metrics, userId, startedAt));
      return reply.send(stream as unknown as string);
    },
  );
}
