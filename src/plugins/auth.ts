import { eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest, preValidationHookHandler } from 'fastify';
import type { Config } from '../config.js';
import type { Database } from '../db/client.js';
import { sessions, users } from '../db/schema.js';
import { unauthorized } from '../lib/errors.js';
import { SESSION_COOKIE, generateSessionToken, hashSessionToken } from '../lib/session.js';

export async function createSession(db: Database, userId: string, ttlHours: number) {
  const token = generateSessionToken();
  const id = hashSessionToken(token);
  const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);
  await db.insert(sessions).values({ id, userId, expiresAt });
  return { token, expiresAt };
}

export async function destroySession(db: Database, token: string) {
  await db.delete(sessions).where(eq(sessions.id, hashSessionToken(token)));
}

export function setSessionCookie(
  reply: FastifyReply,
  config: Config,
  token: string,
  expiresAt: Date,
) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.NODE_ENV === 'production',
    signed: true,
    expires: expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply, config: Config) {
  reply.clearCookie(SESSION_COOKIE, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.NODE_ENV === 'production',
    signed: true,
  });
}

function readToken(request: FastifyRequest): string | null {
  const raw = request.cookies[SESSION_COOKIE];
  if (!raw) return null;
  const unsigned = request.unsignCookie(raw);
  return unsigned.valid && unsigned.value ? unsigned.value : null;
}

/**
 * Resolves the session on every request but never rejects; routes opt in to
 * enforcement with `requireAuth` so public endpoints stay explicit.
 */
export function createSessionLoader(db: Database) {
  return async function loadSession(request: FastifyRequest): Promise<void> {
    const token = readToken(request);
    if (!token) return;

    const id = hashSessionToken(token);
    const rows = await db
      .select({
        sessionId: sessions.id,
        expiresAt: sessions.expiresAt,
        userId: users.id,
        email: users.email,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.id, id))
      .limit(1);

    const row = rows[0];
    if (!row) return;
    if (row.expiresAt.getTime() <= Date.now()) {
      await db.delete(sessions).where(eq(sessions.id, id));
      return;
    }

    request.user = { id: row.userId, email: row.email };
    request.sessionId = row.sessionId;
  };
}

// preValidation, not onRequest: @fastify/rate-limit attaches its own hook to
// each route's onRequest array, appending after whatever is already there. If
// requireAuth lived at onRequest, its early rejection of an unauthenticated
// request would short-circuit the chain and the rate-limit hook after it
// would never run — exempting unauthenticated traffic from rate limiting.
// preValidation still runs ahead of body-schema validation, so an
// unauthenticated request never gets a free validation-error response either.
export const requireAuth: preValidationHookHandler = function requireAuth(request, _reply, done) {
  if (!request.user) {
    done(unauthorized());
    return;
  }
  done();
};
