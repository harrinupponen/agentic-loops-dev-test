import { and, desc, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import { todos } from '../db/schema.js';
import { notFound } from '../lib/errors.js';
import { IdempotencyKeySchema } from '../lib/idempotency.js';
import type { TodoListCache } from '../lib/todo-list-cache.js';
import { requireAuth } from '../plugins/auth.js';
import type { Metrics } from '../plugins/metrics.js';

/**
 * OBLIGATION FOR ANYONE ADDING A WRITE HANDLER HERE: every successful write to a
 * user's todos must `await cache?.invalidate(userId)` before it responds. It is
 * an explicit call in each handler rather than an onResponse hook, so a reviewer
 * reading one handler can see what it does to the cache (ADR 0020). The cost is
 * that a new handler can forget, which is why there is one integration case per
 * mutating route.
 */

/**
 * How long a soft-deleted todo stays recoverable. A constant, not configuration:
 * a retention period is a product and privacy decision that belongs in the spec
 * and in ADR 0017, not in a `.env` file where environments can differ silently.
 */
const RETENTION_DAYS = 30;

/**
 * Rows the opportunistic retention sweep may purge in one request, bounded so a
 * user with a large expired backlog cannot turn one delete into a long DELETE.
 * What a batch leaves behind, that user's next delete picks up. Copied from
 * src/plugins/idempotency.ts rather than reinvented (ADR 0017).
 */
const SWEEP_BATCH = 100;

const TodoView = z.object({
  id: z.string().uuid(),
  title: z.string(),
  completed: z.boolean(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  // null for every live todo. Additive, so existing clients are unaffected.
  deletedAt: z.coerce.date().nullable(),
});

/**
 * The list response, exported because the cache re-validates a stored entry
 * against this exact schema before serving it: an entry written by a previous
 * release is a miss rather than a shape the OpenAPI contract does not describe.
 */
export const TodoListResponse = z.object({
  items: z.array(TodoView),
  nextCursor: z.coerce.date().nullable(),
});

export type TodoListBody = z.infer<typeof TodoListResponse>;

const IdParam = z.object({ id: z.string().uuid() });

// Optional: a request without the header behaves exactly as it did before.
// passthrough() so validating this one header does not strip the others.
const IdempotencyHeaders = z
  .object({ 'idempotency-key': IdempotencyKeySchema.optional() })
  .passthrough();

// The 409s below are raised as AppErrors, so this must match the global error
// body exactly — a mismatch makes the serializer turn the response into a 500.
const ErrorResponse = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
  requestId: z.string(),
});

// Keyset pagination: stays O(limit) no matter how deep the user scrolls.
// OFFSET would degrade linearly and is the first thing to break under load.
const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.coerce.date().optional(),
  completed: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  // The single explicit opt-out of "live rows only". `true` returns ONLY
  // deleted rows — never a mix, so no client has to re-derive "is this one
  // gone?" per row. Same sort key and same cursor shape in both modes.
  deleted: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export function registerTodoRoutes(
  app: FastifyInstance,
  db: Database,
  idempotency: preHandlerAsyncHookHandler,
  metrics: Pick<Metrics, 'todosSoftDeleted'>,
  /** null whenever either switch is off, which short-circuits every call site. */
  cache: TodoListCache | null = null,
) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/api/todos',
    {
      preValidation: requireAuth,
      schema: {
        tags: ['todos'],
        querystring: ListQuery,
        response: { 200: TodoListResponse },
      },
    },
    async (request) => {
      const { limit, cursor, completed, deleted } = request.query;
      const userId = request.user!.id;

      // Only cursor-less requests are cached: a cursor's cardinality is the
      // user's row count, so caching one buys hit rate on the pages that are
      // requested least (ADR 0020). With no cache configured this is `false` at
      // every call site below and the executed path is the pre-F-012 one.
      const cacheable = cache !== null && cursor === undefined;
      const variant = { deleted, completed, limit };
      if (cacheable) {
        const hit = await cache.get(userId, variant);
        if (hit) return hit;
      }

      // In the WHERE, never a .filter() on the rows that come back: the handler
      // fetches limit + 1 rows already filtered, so pages stay full and
      // nextCursor stays correct. Same rule as the authorization one.
      const conditions = [
        eq(todos.userId, userId),
        deleted ? isNotNull(todos.deletedAt) : isNull(todos.deletedAt),
      ];
      if (cursor) conditions.push(lt(todos.createdAt, cursor));
      if (completed !== undefined) conditions.push(eq(todos.completed, completed));

      const rows = await db
        .select()
        .from(todos)
        .where(and(...conditions))
        .orderBy(desc(todos.createdAt))
        .limit(limit + 1);

      const items = rows.slice(0, limit);
      const nextCursor = rows.length > limit ? (items.at(-1)?.createdAt ?? null) : null;
      const body = { items, nextCursor };
      // Awaited, not fired and forgotten: worst case it adds REDIS_TIMEOUT_MS to
      // a path that has already paid for a Postgres query.
      if (cacheable) await cache.set(userId, variant, body);
      return body;
    },
  );

  r.post(
    '/api/todos',
    {
      preValidation: requireAuth,
      // preHandler, so the body is already parsed when the fingerprint is taken.
      preHandler: idempotency,
      schema: {
        tags: ['todos'],
        headers: IdempotencyHeaders,
        body: z.object({ title: z.string().trim().min(1).max(500) }),
        response: { 201: TodoView, 409: ErrorResponse },
      },
    },
    async (request, reply) => {
      const created = await db
        .insert(todos)
        .values({ userId: request.user!.id, title: request.body.title })
        .returning();
      await cache?.invalidate(request.user!.id);
      return reply.status(201).send(created[0]!);
    },
  );

  r.get(
    '/api/todos/:id',
    {
      preValidation: requireAuth,
      schema: { tags: ['todos'], params: IdParam, response: { 200: TodoView } },
    },
    async (request) => {
      const rows = await db
        .select()
        .from(todos)
        .where(
          and(
            eq(todos.id, request.params.id),
            eq(todos.userId, request.user!.id),
            // A deleted todo behaves exactly as if the row were gone.
            isNull(todos.deletedAt),
          ),
        )
        .limit(1);
      // 404 rather than 403 for another user's row: do not confirm it exists.
      if (!rows[0]) throw notFound('Todo not found');
      return rows[0];
    },
  );

  r.patch(
    '/api/todos/:id',
    {
      preValidation: requireAuth,
      schema: {
        tags: ['todos'],
        params: IdParam,
        body: z
          .object({
            title: z.string().trim().min(1).max(500).optional(),
            completed: z.boolean().optional(),
          })
          .refine((v) => v.title !== undefined || v.completed !== undefined, {
            message: 'At least one of title or completed must be provided',
          }),
        response: { 200: TodoView },
      },
    },
    async (request) => {
      const updated = await db
        .update(todos)
        .set({ ...request.body, updatedAt: sql`now()` })
        .where(
          and(
            eq(todos.id, request.params.id),
            eq(todos.userId, request.user!.id),
            // Writes exclude deleted rows too, not just reads: editing
            // something you deleted must not be a reachable state. The only
            // transition out of the deleted state is restore.
            isNull(todos.deletedAt),
          ),
        )
        .returning();
      // After the 404 check: a failed write invalidates nothing, because it
      // changed nothing.
      if (!updated[0]) throw notFound('Todo not found');
      await cache?.invalidate(request.user!.id);
      return updated[0];
    },
  );

  r.delete(
    '/api/todos/:id',
    {
      preValidation: requireAuth,
      schema: { tags: ['todos'], params: IdParam, response: { 204: z.null() } },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      // Marks, never removes. `deleted_at IS NULL` is what makes a second
      // DELETE a 404 and keeps the first stamp in place: an already-deleted
      // todo and an unknown id are indistinguishable to the caller.
      const deleted = await db
        .update(todos)
        .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
        .where(
          and(eq(todos.id, request.params.id), eq(todos.userId, userId), isNull(todos.deletedAt)),
        )
        .returning({ id: todos.id });
      if (!deleted[0]) throw notFound('Todo not found');

      metrics.todosSoftDeleted.inc({ action: 'deleted' }, 1);
      // The action and nothing else: a title is user content and never logged.
      request.log.info({ todo: { action: 'delete' } }, 'todo soft deleted');

      // Opportunistic retention sweep, attached to the operation that creates
      // the garbage rather than to a read (ADR 0017). Scoped to the caller in
      // both the outer statement and the subselect, so a mistake in one cannot
      // widen it to another account; bounded to one batch; best-effort, because
      // bookkeeping never fails a user's request. Copied from
      // src/plugins/idempotency.ts.
      try {
        const purged = await db.execute(sql`
          DELETE FROM todos
           WHERE user_id = ${userId}
             AND id IN (SELECT id
                          FROM todos
                         WHERE user_id = ${userId}
                           AND deleted_at < now() - make_interval(days => ${RETENTION_DAYS})
                         LIMIT ${SWEEP_BATCH})`);
        if (purged.rowCount) {
          metrics.todosSoftDeleted.inc({ action: 'purged' }, purged.rowCount);
          request.log.info({ todo: { action: 'purge', count: purged.rowCount } }, 'todos purged');
        }
      } catch (err) {
        // The one line that answers "why is `purged` flat at zero".
        request.log.warn({ err, todo: { outcome: 'sweep_failed' } }, 'todo retention sweep');
      }

      // After the sweep, so one DEL covers both the row this request deleted and
      // the rows the sweep removed from this user's trash view.
      await cache?.invalidate(userId);
      return reply.status(204).send(null);
    },
  );

  r.post(
    '/api/todos/:id/restore',
    {
      preValidation: requireAuth,
      schema: { tags: ['todos'], params: IdParam, response: { 200: TodoView } },
    },
    async (request) => {
      // Deliberately no `deleted_at IS NOT NULL` predicate: restoring a live
      // todo is a no-op success, so a double click, a retry after a dropped
      // connection, and a second tab that already restored it all return the
      // same row and the same status. The visible cost is that updated_at moves.
      const restored = await db
        .update(todos)
        .set({ deletedAt: null, updatedAt: sql`now()` })
        .where(and(eq(todos.id, request.params.id), eq(todos.userId, request.user!.id)))
        .returning();
      if (!restored[0]) throw notFound('Todo not found');

      metrics.todosSoftDeleted.inc({ action: 'restored' }, 1);
      request.log.info({ todo: { action: 'restore' } }, 'todo restored');
      // Covers both the live list and the trash: the row reappears mid-ordering
      // at its original created_at, which is exactly the case whole-user
      // invalidation handles for free (ADR 0020).
      await cache?.invalidate(request.user!.id);
      // The full row, so the client can place it back at its original position
      // without a refetch (ADR 0008) — it returns at its original created_at.
      return restored[0];
    },
  );
}
