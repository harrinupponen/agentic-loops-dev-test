import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Database } from '../db/client.js';

export function registerHealthRoutes(app: FastifyInstance, db: Database) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // Liveness: process is up. Must not touch dependencies, or an orchestrator
  // will restart healthy pods whenever the database blips.
  r.get(
    '/healthz',
    {
      logLevel: 'warn',
      config: { rateLimit: false },
      schema: {
        tags: ['health'],
        response: { 200: z.object({ status: z.literal('ok'), uptime: z.number() }) },
      },
    },
    async () => ({ status: 'ok' as const, uptime: process.uptime() }),
  );

  // Readiness: safe to route traffic here. Checked by the load balancer.
  r.get(
    '/readyz',
    {
      logLevel: 'warn',
      config: { rateLimit: false },
      schema: {
        tags: ['health'],
        response: {
          200: z.object({ status: z.literal('ready') }),
          503: z.object({ status: z.literal('not_ready'), reason: z.string() }),
        },
      },
    },
    async (_request, reply) => {
      if (app.isShuttingDown) {
        return reply.status(503).send({ status: 'not_ready' as const, reason: 'shutting_down' });
      }
      try {
        await db.execute(sql`select 1`);
        return { status: 'ready' as const };
      } catch {
        return reply.status(503).send({ status: 'not_ready' as const, reason: 'database' });
      }
    },
  );
}
