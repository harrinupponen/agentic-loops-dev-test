import { sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { Database } from '../db/client.js';
import { auditEvents } from '../db/schema.js';
import type { Metrics } from '../plugins/metrics.js';

/**
 * The closed set of security-relevant events, enforced here rather than by a
 * CHECK constraint on the column (ADR 0025): the database would make adding an
 * action a destructive migration, while this union makes an unknown value a
 * compile error at the one call site that can produce it.
 *
 * Deliberately absent: anything about todos (not a security event), email
 * verification (nothing authorizes on it, ADR 0011), logout (the user pressed
 * the button on the device in their hand one second ago — the event has no
 * reader), and reading this log (a user looking at their own data is not a
 * security event).
 */
export type AuditAction =
  | 'auth.register'
  | 'auth.login'
  | 'password_reset.requested'
  | 'password_reset.completed'
  | 'session.revoked'
  | 'session.revoked_others'
  // A single request that extracts everything this application knows about an
  // account is the most valuable thing an attacker holding a stolen cookie can
  // do, so it is credential-lifecycle-grade rather than a product operation —
  // the extension path ADR 0025 left open, taken for the first time. The row is
  // written before the first byte of the stream, so `success` means the request
  // was authorized and the export began; whether the download finished is
  // account_exports_total's job, not this log's.
  | 'account.exported';

export type AuditOutcome = 'success' | 'failure';

export type AuditMetrics = Pick<
  Metrics,
  'auditEvents' | 'auditWriteFailures' | 'auditEventsPurged'
>;

/**
 * How long an audit row is kept. A constant, not configuration: a retention
 * period is a privacy decision that belongs in the spec and in ADR 0017, not in
 * a `.env` file where two environments can differ without anyone noticing.
 * Ninety rather than F-010's thirty because this table answers retrospective
 * questions, and a month is routinely shorter than the gap between a compromise
 * and its discovery.
 */
export const AUDIT_RETENTION_DAYS = 90;

/**
 * Rows one sweep may purge, bounded so an account with a large expired backlog
 * cannot turn one sign-in into a long DELETE. Copied from src/routes/todos.ts
 * rather than reinvented (ADR 0017).
 */
const SWEEP_BATCH = 100;

/**
 * The one and only writer of `audit_events`.
 *
 * Awaited, wrapped in try/catch, and NEVER fatal to the request it describes
 * (ADR 0024). The operation this row is about has already happened — a session
 * exists, a password changed — so turning a failed bookkeeping insert into a
 * 500 would report an error for work that succeeded, and making it fatal for
 * real would mean putting the insert inside the operation's transaction, which
 * is how an audit log becomes a new way to attack the operation it describes.
 *
 * Awaited rather than fired and forgotten, unlike the mailer in
 * src/routes/auth.ts: a dropped mail is eventually visible to a human waiting
 * for it, while a dropped audit row is visible to nobody, ever. Awaiting keeps
 * the failure inside the request that caused it, where the request id and the
 * trace id still exist, and costs one round trip on a path that has already
 * paid for argon2.
 *
 * The honest cost is that the trail can have holes, which is exactly what
 * `audit_write_failures_total` is for: it is the only counter in this
 * application whose correct value is zero.
 *
 * MUST be called after the state change it describes and outside its
 * transaction.
 */
export async function recordAuditEvent(
  request: FastifyRequest,
  db: Database,
  metrics: AuditMetrics,
  event: { userId: string; action: AuditAction; outcome: AuditOutcome },
): Promise<void> {
  try {
    await db.insert(auditEvents).values({
      userId: event.userId,
      action: event.action,
      outcome: event.outcome,
    });
    metrics.auditEvents.inc({ action: event.action, outcome: event.outcome }, 1);
  } catch (err) {
    metrics.auditWriteFailures.inc(1);
    // error level, and the action only: never the user id, never the address.
    // The one line that says this account's trail is incomplete.
    request.log.error(
      { err, audit: { action: event.action, outcome: event.outcome } },
      'audit write failed',
    );
  }
}

/**
 * Opportunistic retention sweep, attached to the sign-in path on BOTH outcomes
 * and to nothing else. ADR 0017's four rules: caller-scoped in the outer
 * statement and in the subselect, so a mistake in one cannot widen it to
 * another account; bounded to one batch; best-effort, because bookkeeping never
 * fails a user's request; and attached to an operation that produces rows
 * rather than to a read.
 *
 * Both outcomes matters here more than anywhere else in the application: the
 * high-volume rows in this table are failed sign-ins against a targeted
 * account, written by the attacker rather than by the victim, so sweeping on
 * failure makes the attacker's own traffic purge up to 100 rows for every 1 it
 * writes.
 *
 * The stated cost, unchanged from ADR 0017: an account nobody ever signs in
 * against again keeps its rows past the window, so retention is AT LEAST 90
 * days, not at most.
 */
export async function sweepAuditEvents(
  request: FastifyRequest,
  db: Database,
  metrics: AuditMetrics,
  userId: string,
): Promise<void> {
  try {
    const purged = await db.execute(sql`
      DELETE FROM audit_events
       WHERE user_id = ${userId}
         AND (user_id, created_at, id) IN (SELECT user_id, created_at, id
                                             FROM audit_events
                                            WHERE user_id = ${userId}
                                              AND created_at < now() - make_interval(days => ${AUDIT_RETENTION_DAYS})
                                            LIMIT ${SWEEP_BATCH})`);
    if (purged.rowCount) {
      metrics.auditEventsPurged.inc(purged.rowCount);
      request.log.info(
        { audit: { action: 'purge', count: purged.rowCount } },
        'audit events purged',
      );
    }
  } catch (err) {
    // The one line that answers "why is audit_events_purged_total flat at zero".
    request.log.warn({ err, audit: { outcome: 'sweep_failed' } }, 'audit retention sweep');
  }
}
