import { and, desc, eq, gt, ne, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Database } from '../db/client.js';
import { sessions } from '../db/schema.js';
import { notFound, unauthorized } from '../lib/errors.js';
import { clearSessionCookie, requireAuth } from '../plugins/auth.js';
import type { Metrics } from '../plugins/metrics.js';

/**
 * The only representation of a session that leaves the server.
 *
 * `id` is `sessions.public_id`, never `sessions.id` — the latter is
 * sha256(token) and handing it out gives away a verifier for a live credential
 * (ADR 0014). The list query selects the hash to compute `current`, and this
 * schema is the mechanical guard that keeps it out of the body: the zod
 * serializer strips every key a response schema does not name.
 */
const SessionView = z.object({
  id: z.string().uuid(),
  createdAt: z.coerce.date(),
  expiresAt: z.coerce.date(),
  // Attacker-controlled text. Returned only to the account that produced it,
  // as a JSON string, and never logged. A client must render it with
  // textContent, never innerHTML (ADR 0015; F-020 inherits this).
  userAgent: z.string().nullable(),
  current: z.boolean(),
});

const IdParam = z.object({ id: z.string().uuid() });

// `details` is optional but MUST be declared: `validation_failed` carries it
// and the zod serializer strips any key the schema does not mention, which
// would silently truncate every validation error on these routes. The same
// note src/routes/auth.ts records, for the same reason.
const ErrorResponse = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  }),
  requestId: z.string(),
});

/** Beyond this the list is truncated rather than paginated; see the spec. */
const LIST_LIMIT = 100;

export function registerSessionRoutes(
  app: FastifyInstance,
  db: Database,
  config: Config,
  metrics: Pick<Metrics, 'sessionsRevoked'>,
) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // 401 is deliberately not declared on all three routes, matching
  // POST /api/auth/verify-email: requireAuth raises it before validation, and
  // no declared schema means no serializer to strip the body.

  r.get(
    '/api/auth/sessions',
    {
      preValidation: requireAuth,
      schema: {
        tags: ['auth'],
        response: {
          200: z.object({ items: z.array(SessionView), truncated: z.boolean() }),
        },
      },
    },
    async (request) => {
      const rows = await db
        .select({
          id: sessions.id,
          publicId: sessions.publicId,
          createdAt: sessions.createdAt,
          expiresAt: sessions.expiresAt,
          userAgent: sessions.userAgent,
        })
        .from(sessions)
        .where(and(eq(sessions.userId, request.user!.id), gt(sessions.expiresAt, sql`now()`)))
        .orderBy(desc(sessions.createdAt))
        // One more than the cap, so "is there a 101st?" costs no second query.
        .limit(LIST_LIMIT + 1);

      return {
        items: rows.slice(0, LIST_LIMIT).map((row) => ({
          id: row.publicId,
          createdAt: row.createdAt,
          expiresAt: row.expiresAt,
          userAgent: row.userAgent,
          // Computed here from a column that is selected and then never
          // serialised. request.sessionId has been set by the session loader
          // since F-002; this is its first consumer.
          current: row.id === request.sessionId,
        })),
        truncated: rows.length > LIST_LIMIT,
      };
    },
  );

  r.delete(
    '/api/auth/sessions/:id',
    {
      preValidation: requireAuth,
      schema: {
        tags: ['auth'],
        params: IdParam,
        response: { 204: z.null(), 400: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (request, reply) => {
      // One statement, scoped by user_id — never a SELECT followed by an
      // ownership check in application code. A row belonging to someone else
      // does not exist as far as this response is concerned, so it 404s rather
      // than 403s and the endpoint is not an existence oracle.
      //
      // Deliberately does not filter on expires_at: a session that expires
      // between the list call and the click should revoke cleanly rather than
      // 404 for a row the user just saw. Either way the row ends up gone.
      const deleted = await db
        .delete(sessions)
        .where(and(eq(sessions.userId, request.user!.id), eq(sessions.publicId, request.params.id)))
        .returning({ id: sessions.id });

      const row = deleted[0];
      if (!row) throw notFound('Session not found');

      // Revoking the session you are holding is allowed and simply logs you
      // out. Without this the browser keeps a cookie for a row that no longer
      // exists and the next request 401s with a stale cookie still set.
      if (row.id === request.sessionId) clearSessionCookie(reply, config);

      metrics.sessionsRevoked.inc({ scope: 'single' }, 1);
      // The outcome and a number: never a public id, a hash, or a user agent.
      request.log.info(
        { session: { action: 'revoke', scope: 'single', count: 1 } },
        'session revoked',
      );
      return reply.status(204).send(null);
    },
  );

  r.delete(
    '/api/auth/sessions',
    {
      preValidation: requireAuth,
      schema: { tags: ['auth'], response: { 204: z.null() } },
    },
    async (request, reply) => {
      const currentSessionId = request.sessionId;
      // The loader sets request.user and request.sessionId together, so this
      // cannot happen. The guard is what stops a future refactor turning "sign
      // out everywhere else" into "sign out everywhere" — running the statement
      // without the exclusion would log the caller out too.
      if (!currentSessionId) throw unauthorized();

      const deleted = await db
        .delete(sessions)
        .where(and(eq(sessions.userId, request.user!.id), ne(sessions.id, currentSessionId)))
        .returning({ id: sessions.id });

      metrics.sessionsRevoked.inc({ scope: 'others' }, deleted.length);
      request.log.info(
        { session: { action: 'revoke', scope: 'others', count: deleted.length } },
        'sessions revoked',
      );
      // 204 always, even at zero rows: the client already knows which rows it
      // listed and removes them without a refetch (ADR 0008).
      return reply.status(204).send(null);
    },
  );
}
