import { sql } from 'drizzle-orm';
import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import type { Counter } from 'prom-client';
import type { Config } from '../config.js';
import type { Database } from '../db/client.js';
import { conflict } from '../lib/errors.js';
import { IDEMPOTENCY_HEADER, requestFingerprint } from '../lib/idempotency.js';

/**
 * How long an `in_progress` record blocks a duplicate. Not a distributed lock:
 * it only stops one killed request from poisoning a key for the whole TTL.
 */
const LEASE_SECONDS = 60;

type ExistingRecord = {
  fingerprint: string;
  status: string;
  response_status: number | null;
  response_body: unknown;
};

/**
 * Registers the global `onSend` finaliser and returns the `preHandler` that a
 * route opts into. Runs after `requireAuth` and after body validation, so the
 * caller is known and the parsed body is available for the fingerprint.
 */
export function registerIdempotency(
  app: FastifyInstance,
  db: Database,
  config: Config,
  counter: Counter<'outcome'>,
): preHandlerAsyncHookHandler {
  const ttlHours = config.IDEMPOTENCY_TTL_HOURS;

  // No-ops unless the request claimed a key. Only 2xx is stored; anything else
  // releases the key so the client can correct or retry with the same one.
  app.addHook('onSend', async (request, reply, payload) => {
    const claimed = request.idempotency;
    if (!claimed) return payload;

    const stored = typeof payload === 'string' && reply.statusCode >= 200 && reply.statusCode < 300;
    try {
      if (stored) {
        await db.execute(sql`
          UPDATE idempotency_keys
             SET status = 'completed',
                 response_status = ${reply.statusCode},
                 response_body = ${payload}::jsonb
           WHERE user_id = ${claimed.userId} AND key = ${claimed.key}`);
        counter.inc({ outcome: 'stored' });
      } else {
        await db.execute(sql`
          DELETE FROM idempotency_keys
           WHERE user_id = ${claimed.userId} AND key = ${claimed.key}`);
      }
    } catch (err) {
      // The response is already correct; a stale record expires or is taken
      // over after the lease. Never fail the request over bookkeeping.
      request.log.error({ err, idempotency: { outcome: 'finalise_failed' } }, 'idempotency');
    }
    return payload;
  });

  return async function idempotency(request, reply) {
    const key = request.headers[IDEMPOTENCY_HEADER];
    // Absent (or, defensively, repeated) header: today's behaviour exactly.
    if (typeof key !== 'string') return;

    const userId = request.user!.id;
    const route = request.routeOptions.url ?? request.url;
    const fingerprint = requestFingerprint(request.method, route, request.body);

    // Single autocommitted statement, so the claim is immediately visible to a
    // concurrent duplicate. A returned row means this request owns the key:
    // fresh insert, expired record, or an abandoned attempt taken over.
    const claim = await db.execute<{ inserted: boolean }>(sql`
      INSERT INTO idempotency_keys (user_id, key, fingerprint, status, expires_at)
      VALUES (${userId}, ${key}, ${fingerprint}, 'in_progress',
              now() + make_interval(hours => ${ttlHours}))
      ON CONFLICT (user_id, key) DO UPDATE
        SET fingerprint = EXCLUDED.fingerprint,
            status = 'in_progress',
            response_status = NULL,
            response_body = NULL,
            created_at = now(),
            expires_at = EXCLUDED.expires_at
        WHERE idempotency_keys.expires_at < now()
           OR (idempotency_keys.status = 'in_progress'
               AND idempotency_keys.created_at < now() - make_interval(secs => ${LEASE_SECONDS}))
      RETURNING (xmax = 0) AS inserted`);

    const claimed = claim.rows[0];
    if (!claimed) {
      const existing = await db.execute<ExistingRecord>(sql`
        SELECT fingerprint, status, response_status, response_body
          FROM idempotency_keys
         WHERE user_id = ${userId} AND key = ${key}`);
      const record = existing.rows[0];
      // Raced with the owner's release: nothing to replay, run normally.
      if (!record) return;

      if (record.fingerprint !== fingerprint) {
        counter.inc({ outcome: 'conflict' });
        request.log.info({ idempotency: { outcome: 'conflict', route } }, 'idempotency');
        throw conflict(
          'idempotency_key_reuse',
          'This Idempotency-Key was already used for a different request',
        );
      }

      if (record.status !== 'completed') {
        counter.inc({ outcome: 'conflict' });
        request.log.info({ idempotency: { outcome: 'in_progress', route } }, 'idempotency');
        reply.header('retry-after', '1');
        throw conflict('idempotency_in_progress', 'An identical request is still in progress');
      }

      counter.inc({ outcome: 'replayed' });
      request.log.info({ idempotency: { outcome: 'replayed', route } }, 'idempotency');
      reply.header('idempotency-replayed', 'true');
      return reply.status(record.response_status ?? 200).send(record.response_body);
    }

    if (!claimed.inserted) {
      counter.inc({ outcome: 'takeover' });
      request.log.info({ idempotency: { outcome: 'takeover', route } }, 'idempotency');
    }

    // Opportunistic retention sweep, over this user's rows only (primary key
    // leading column). No background reaper to own and monitor.
    await db.execute(sql`
      DELETE FROM idempotency_keys WHERE user_id = ${userId} AND expires_at < now()`);

    request.idempotency = { userId, key };
  };
}
