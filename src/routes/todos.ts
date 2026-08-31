import { and, desc, eq, lt, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import { todos } from '../db/schema.js';
import { notFound } from '../lib/errors.js';
import { requireAuth } from '../plugins/auth.js';

const TodoView = z.object({
  id: z.string().uuid(),
  title: z.string(),
  completed: z.boolean(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

const IdParam = z.object({ id: z.string().uuid() });

// Keyset pagination: stays O(limit) no matter how deep the user scrolls.
// OFFSET would degrade linearly and is the first thing to break under load.
const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.coerce.date().optional(),
  completed: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});

export function registerTodoRoutes(app: FastifyInstance, db: Database) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/api/todos',
    {
      preValidation: requireAuth,
      schema: {
        tags: ['todos'],
        querystring: ListQuery,
        response: {
          200: z.object({ items: z.array(TodoView), nextCursor: z.coerce.date().nullable() }),
        },
      },
    },
    async (request) => {
      const { limit, cursor, completed } = request.query;
      const userId = request.user!.id;

      const conditions = [eq(todos.userId, userId)];
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
      return { items, nextCursor };
    },
  );

  r.post(
    '/api/todos',
    {
      preValidation: requireAuth,
      schema: {
        tags: ['todos'],
        body: z.object({ title: z.string().trim().min(1).max(500) }),
        response: { 201: TodoView },
      },
    },
    async (request, reply) => {
      const created = await db
        .insert(todos)
        .values({ userId: request.user!.id, title: request.body.title })
        .returning();
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
        .where(and(eq(todos.id, request.params.id), eq(todos.userId, request.user!.id)))
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
        .where(and(eq(todos.id, request.params.id), eq(todos.userId, request.user!.id)))
        .returning();
      if (!updated[0]) throw notFound('Todo not found');
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
      const deleted = await db
        .delete(todos)
        .where(and(eq(todos.id, request.params.id), eq(todos.userId, request.user!.id)))
        .returning({ id: todos.id });
      if (!deleted[0]) throw notFound('Todo not found');
      return reply.status(204).send(null);
    },
  );
}
