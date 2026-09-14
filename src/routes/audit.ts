import { and, desc, eq, lt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import { auditEvents } from '../db/schema.js';
import { requireAuth } from '../plugins/auth.js';

/**
 * The only representation of an audit event, and the mechanical guard that
 * keeps the owner column out of a body: the zod serializer strips every key a
 * response schema does not name, so `user_id` cannot reach a response even by
 * accident — the same guard F-009 used for the session token hash.
 *
 * `action` and `outcome` are z.string(), NOT z.enum(), and that is deliberate.
 * The action set grows every time a future feature adds a security surface, and
 * a declared enum would make this route a rolling-deploy hazard: a new instance
 * writes `some.new.action`, an old instance serves the list, and the serializer
 * — which validates as well as strips — turns one unknown string into a 500 on
 * the one route whose entire job is to be readable during an incident. The
 * closed set is enforced where it can be enforced safely, in the TypeScript
 * union src/lib/audit.ts accepts.
 */
const AuditEventView = z.object({
  // The row's own id: not a session id, not a user id, and not a capability.
  id: z.string().uuid(),
  // Documented rather than constrained. Today: auth.register, auth.login,
  // password_reset.requested, password_reset.completed, session.revoked,
  // session.revoked_others. A client must render an unknown value defensively.
  action: z.string(),
  // 'success' or 'failure'.
  outcome: z.string(),
  createdAt: z.coerce.date(),
});

const AuditListResponse = z.object({
  items: z.array(AuditEventView),
  nextCursor: z.coerce.date().nullable(),
});

// Copied from src/routes/todos.ts rather than reinvented: same names, same
// bounds, same coercion, same { items, nextCursor } envelope. Keyset only —
// OFFSET degrades linearly with depth, and this is the list that gets deep.
const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.coerce.date().optional(),
});

// `details` is optional but MUST be declared: `validation_failed` carries it
// and the zod serializer strips any key the schema does not mention, which
// would silently truncate every validation error on this route.
const ErrorResponse = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  }),
  requestId: z.string(),
});

export function registerAuditRoutes(app: FastifyInstance, db: Database) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // 401 is deliberately not declared, matching the session routes: requireAuth
  // raises it before validation, and no declared schema means no serializer to
  // strip the body.
  r.get(
    '/api/auth/audit-events',
    {
      preValidation: requireAuth,
      schema: {
        tags: ['auth'],
        description:
          "The caller's own security-relevant events, newest first. `action` is one of " +
          'auth.register, auth.login, password_reset.requested, password_reset.completed, ' +
          'session.revoked, session.revoked_others, and `outcome` is success or failure. ' +
          'Both are opaque strings: a newer server may send a value this list has never ' +
          'carried before, and a client must render it defensively. The absence of an ' +
          'event is not proof that nothing happened — a write that fails is never fatal ' +
          'to the operation it describes (ADR 0024). Events older than 90 days are purged.',
        querystring: ListQuery,
        response: { 200: AuditListResponse, 400: ErrorResponse },
      },
    },
    async (request) => {
      const { limit, cursor } = request.query;

      // Scoped by user_id in the WHERE, never fetched and then checked. The
      // cursor is ANDed with it, so a forged or borrowed cursor selects a
      // different slice of the caller's own rows and nothing else (ADR 0002).
      const conditions = [eq(auditEvents.userId, request.user!.id)];
      if (cursor) conditions.push(lt(auditEvents.createdAt, cursor));

      const rows = await db
        .select({
          id: auditEvents.id,
          action: auditEvents.action,
          outcome: auditEvents.outcome,
          createdAt: auditEvents.createdAt,
        })
        .from(auditEvents)
        .where(and(...conditions))
        // A backward scan of the (user_id, created_at, id) primary key, which
        // is why this feature adds no index. `id` only breaks ties, so the
        // order is total even when two rows share a timestamp; the cursor
        // itself is the timestamp alone, exactly as the todo list's is.
        .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
        // One more than the page, so "is there another page?" costs no second
        // query.
        .limit(limit + 1);

      const items = rows.slice(0, limit);
      return {
        items,
        nextCursor: rows.length > limit ? (items.at(-1)?.createdAt ?? null) : null,
      };
    },
  );
}
