import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Database } from '../db/client.js';
import { passwordResetTokens, sessions, users } from '../db/schema.js';
import { AppError, badRequest, conflict, unauthorized } from '../lib/errors.js';
import type { Mailer } from '../lib/mailer.js';
import { SESSION_COOKIE } from '../lib/session.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import {
  ResetTokenSchema,
  generateResetToken,
  hashResetToken,
  resetTokenExpiry,
} from '../lib/reset-token.js';
import type { Metrics } from '../plugins/metrics.js';
import {
  clearSessionCookie,
  createSession,
  destroySession,
  requireAuth,
  setSessionCookie,
} from '../plugins/auth.js';

const Credentials = z.object({
  email: z.string().email().max(254).toLowerCase(),
  password: z.string().min(12).max(200),
});

const UserView = z.object({ id: z.string().uuid(), email: z.string().email() });

// Same shape the global error handler emits. `details` is optional but MUST be
// declared: `validation_failed` carries it, and the zod serializer strips any
// key the schema does not mention — which would silently truncate every
// validation error on these routes. F-007 hit the neighbouring version of this.
const ErrorResponse = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  }),
  requestId: z.string(),
});

export function registerAuthRoutes(
  app: FastifyInstance,
  db: Database,
  config: Config,
  mailer: Mailer,
  metrics: Pick<Metrics, 'passwordResets' | 'mailMessages'>,
) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // Auth endpoints are the cheapest place to mount a credential-stuffing
  // attack, so they get a far tighter, separately configurable budget than
  // the global limit.
  const authRateLimit = {
    rateLimit: { max: config.AUTH_RATE_LIMIT_MAX, timeWindow: '1 minute' },
  };

  r.post(
    '/api/auth/register',
    {
      config: authRateLimit,
      schema: {
        tags: ['auth'],
        body: Credentials,
        response: { 201: UserView },
      },
    },
    async (request, reply) => {
      const { email, password } = request.body;
      const passwordHash = await hashPassword(password);

      const inserted = await db
        .insert(users)
        .values({ email, passwordHash })
        .onConflictDoNothing({ target: users.email })
        .returning({ id: users.id, email: users.email });

      const user = inserted[0];
      if (!user) throw conflict('email_taken', 'An account with that email already exists');

      const { token, expiresAt } = await createSession(db, user.id, config.SESSION_TTL_HOURS);
      setSessionCookie(reply, config, token, expiresAt);
      return reply.status(201).send(user);
    },
  );

  r.post(
    '/api/auth/login',
    {
      config: authRateLimit,
      schema: { tags: ['auth'], body: Credentials, response: { 200: UserView } },
    },
    async (request, reply) => {
      const { email, password } = request.body;
      const rows = await db
        .select({ id: users.id, email: users.email, passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);

      const user = rows[0];
      // Always run a verification so response time does not reveal account existence.
      const digest = user?.passwordHash ?? DUMMY_HASH;
      const ok = await verifyPassword(digest, password);
      if (!user || !ok) throw unauthorized('Invalid email or password');

      const { token, expiresAt } = await createSession(db, user.id, config.SESSION_TTL_HOURS);
      setSessionCookie(reply, config, token, expiresAt);
      return reply.send({ id: user.id, email: user.email });
    },
  );

  r.post(
    '/api/auth/logout',
    {
      schema: { tags: ['auth'], response: { 204: z.null() } },
    },
    async (request, reply) => {
      const raw = request.cookies[SESSION_COOKIE];
      if (raw) {
        const unsigned = request.unsignCookie(raw);
        if (unsigned.valid && unsigned.value) await destroySession(db, unsigned.value);
      }
      clearSessionCookie(reply, config);
      return reply.status(204).send(null);
    },
  );

  r.get(
    '/api/auth/me',
    {
      preValidation: requireAuth,
      schema: { tags: ['auth'], response: { 200: UserView } },
    },
    (request) => request.user!,
  );

  // Public by design. Always 202, known address or not: a 404 (or any body
  // describing what happened) is a clean user-enumeration oracle.
  r.post(
    '/api/auth/password-reset',
    {
      config: {
        rateLimit: { max: config.PASSWORD_RESET_RATE_LIMIT_MAX, timeWindow: '1 hour' },
      },
      schema: {
        tags: ['auth'],
        body: z.object({ email: z.string().email().max(254).toLowerCase() }),
        // z.void(), not z.null(): the contract is an empty body, and z.null()
        // would serialise the four-byte body "null". Unlike a 204, a 202 does
        // not get its body stripped by the framework.
        response: { 202: z.void(), 400: ErrorResponse },
      },
    },
    async (request, reply) => {
      const { email } = request.body;
      metrics.passwordResets.inc({ outcome: 'requested' });

      const rows = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      const user = rows[0];

      // Generated on BOTH branches so response time does not reveal account
      // existence — the same reason login always runs verifyPassword against
      // DUMMY_HASH. On the unknown branch these are simply discarded.
      const token = generateResetToken();
      const tokenHash = hashResetToken(token);
      const expiresAt = resetTokenExpiry(config.PASSWORD_RESET_TTL_MINUTES);

      if (user) {
        // Claim the single slot for this account in one statement. The WHERE on
        // DO UPDATE is a 60-second per-account cooldown: it lives in the
        // database, so it holds across instances and across source IPs, unlike
        // the per-IP limit above. Hard-coded because it is a property of the
        // design, not a knob.
        const issued = await db.execute<{ user_id: string }>(sql`
          INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
          VALUES (${user.id}, ${tokenHash}, ${expiresAt})
          ON CONFLICT (user_id) DO UPDATE
            SET token_hash = EXCLUDED.token_hash,
                expires_at = EXCLUDED.expires_at,
                created_at = now()
            WHERE password_reset_tokens.created_at < now() - interval '60 seconds'
          RETURNING user_id
        `);

        // No row means a token was issued for this account within the last 60
        // seconds: send nothing, leave the existing token valid, still 202.
        if (issued.rows.length > 0) {
          // Dispatched, never awaited: awaiting it would put the provider's p99
          // on the response and make a 5xx reachable only for addresses that
          // exist. Failure is visible in the counter, not to the caller.
          void mailer
            .sendPasswordReset({ to: email, token, expiresAt })
            .then(() => {
              metrics.mailMessages.inc({
                kind: 'password_reset',
                transport: mailer.transport,
                outcome: 'sent',
              });
            })
            .catch((err: unknown) => {
              metrics.mailMessages.inc({
                kind: 'password_reset',
                transport: mailer.transport,
                outcome: 'failed',
              });
              request.log.error({ err }, 'password reset mail failed');
            });
        }
      }

      // send() with no argument, not send(null): the latter serialises to the
      // four-byte body "null". The contract is an empty body.
      return reply.status(202).send();
    },
  );

  // Public by design, and deliberately does NOT create a session: signing the
  // user in here would make this a session-minting oracle for anyone holding a
  // token, and would skip the step that proves the new password works.
  r.post(
    '/api/auth/password-reset/confirm',
    {
      config: authRateLimit,
      schema: {
        tags: ['auth'],
        body: z.object({ token: ResetTokenSchema, password: z.string().min(12).max(200) }),
        response: { 204: z.null(), 400: ErrorResponse },
      },
    },
    async (request, reply) => {
      const { token, password } = request.body;

      // Hashed BEFORE the transaction, and before we know the token is valid.
      // Two reasons: it keeps ~50-100ms of argon2 out of a held database
      // connection, and it makes a valid and an invalid token cost the same
      // wall-clock time. The cost is that a garbage token still burns CPU,
      // which is what AUTH_RATE_LIMIT_MAX bounds.
      const passwordHash = await hashPassword(password);
      const tokenHash = hashResetToken(token);

      try {
        await db.transaction(async (tx) => {
          // Deleting IS the single-use check: one atomic statement, no
          // `used_at` column to forget, and two concurrent confirms cannot
          // both win. Served by the unique constraint on token_hash.
          const claimed = await tx
            .delete(passwordResetTokens)
            .where(eq(passwordResetTokens.tokenHash, tokenHash))
            .returning({
              userId: passwordResetTokens.userId,
              expiresAt: passwordResetTokens.expiresAt,
            });

          const row = claimed[0];
          if (!row) throw badRequest('invalid_token', 'That reset link is not valid');

          // Rolls the delete back, so the dead row survives to be overwritten
          // by the next request. Distinguishing expired from unknown is safe:
          // only someone already holding a token can reach either answer.
          if (row.expiresAt.getTime() <= Date.now()) {
            throw badRequest('token_expired', 'That reset link has expired');
          }

          await tx
            .update(users)
            .set({ passwordHash, updatedAt: new Date() })
            .where(eq(users.id, row.userId));

          // Every session, including any the requester holds: this is the
          // recovery path from an account compromise, so leaving one alive
          // defeats the point. Same transaction as the credential change, so
          // there is no window where both the new password and an old session
          // are live. Served by sessions_user_id_idx.
          await tx.delete(sessions).where(eq(sessions.userId, row.userId));
        });
      } catch (err) {
        // Only the two deliberate rejections are counted; an unexpected
        // database failure is a 500 and must not be recorded as a bad token.
        if (err instanceof AppError) {
          const outcome = err.code === 'token_expired' ? 'expired' : 'invalid';
          metrics.passwordResets.inc({ outcome });
          // Outcome only — never the token, the address, or the user id.
          request.log.info({ passwordReset: { outcome } }, 'password reset rejected');
        }
        throw err;
      }

      metrics.passwordResets.inc({ outcome: 'consumed' });
      request.log.info({ passwordReset: { outcome: 'consumed' } }, 'password reset completed');
      return reply.status(204).send(null);
    },
  );
}

// argon2id digest of a random string, used only to equalise login timing.
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$3G0m3fLmA1cwyPzYb8yFwl0Q6oYQ0YQmXk2v3q3jH0E';
