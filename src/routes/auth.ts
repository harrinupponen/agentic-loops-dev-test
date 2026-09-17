import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Database } from '../db/client.js';
import { emailVerificationTokens, passwordResetTokens, sessions, users } from '../db/schema.js';
import { recordAuditEvent, sweepAuditEvents } from '../lib/audit.js';
import { AppError, badRequest, conflict, unauthorized } from '../lib/errors.js';
import type { Mailer } from '../lib/mailer.js';
import { SESSION_COOKIE, truncateUserAgent } from '../lib/session.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import {
  RecoveryTokenSchema,
  generateRecoveryToken,
  hashRecoveryToken,
  recoveryTokenExpiry,
} from '../lib/recovery-token.js';
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

// `emailVerified` is a boolean, not the timestamp: the client needs the state,
// and the timestamp is an internal fact with no consumer. Nothing in the
// application authorizes on it — see docs/adr/0011-email-verification-is-advisory.md.
const UserView = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  emailVerified: z.boolean(),
});

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
  metrics: Pick<
    Metrics,
    | 'passwordResets'
    | 'emailVerifications'
    | 'mailMessages'
    | 'auditEvents'
    | 'auditWriteFailures'
    | 'auditEventsPurged'
  >,
) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // Auth endpoints are the cheapest place to mount a credential-stuffing
  // attack, so they get a far tighter, separately configurable budget than
  // the global limit.
  const authRateLimit = {
    rateLimit: { max: config.AUTH_RATE_LIMIT_MAX, timeWindow: '1 minute' },
  };

  /**
   * Issues a verification token for one account and dispatches the mail.
   * Shared by registration and resend, and the only writer of the table.
   *
   * Awaits the upsert — callers need the row to exist before they answer — but
   * never the send: a mail provider outage must not fail a signup, so failure
   * is a counter and a log line rather than a 5xx (ADR 0010).
   */
  async function issueEmailVerification(
    request: FastifyRequest,
    user: { id: string; email: string },
    outcome: 'issued' | 'resent',
  ): Promise<void> {
    const token = generateRecoveryToken();
    const tokenHash = hashRecoveryToken(token);
    const expiresAt = recoveryTokenExpiry(config.EMAIL_VERIFICATION_TTL_HOURS * 60);

    // Claim the account's single slot in one statement. The WHERE on DO UPDATE
    // is a 60-second per-account cooldown: it lives in the database, so it
    // holds across instances and across source IPs, unlike the per-IP limit.
    // Hard-coded because it is a property of the design, not a knob.
    const issued = await db.execute<{ user_id: string }>(sql`
      INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
      VALUES (${user.id}, ${tokenHash}, ${expiresAt})
      ON CONFLICT (user_id) DO UPDATE
        SET token_hash = EXCLUDED.token_hash,
            expires_at = EXCLUDED.expires_at,
            created_at = now()
        WHERE email_verification_tokens.created_at < now() - interval '60 seconds'
      RETURNING user_id
    `);

    // No row means a token was issued for this account within the last 60
    // seconds: send nothing, leave the existing token valid, count nothing.
    if (issued.rows.length === 0) return;

    metrics.emailVerifications.inc({ outcome });
    if (outcome !== 'issued') {
      // Outcome only — never the token, the address, or the user id.
      request.log.info({ emailVerification: { outcome } }, 'email verification token issued');
    }

    void mailer
      .sendEmailVerification({ to: user.email, token, expiresAt })
      .then((dispatch) => {
        // A transport may decline to send (ADR 0030) and says so here; a
        // transport that always delivers says nothing, and that reads as `sent`.
        // Counting a withheld message as `sent` would make the one counter this
        // feature is alerted on lie.
        const outcome = dispatch?.outcome ?? 'sent';
        metrics.mailMessages.inc({
          kind: 'email_verification',
          transport: mailer.transport,
          outcome,
        });
        if (dispatch) {
          // No address, no token, no key, no body — the reason, which is where
          // ADR 0030 puts it rather than in a label.
          request.log.info(
            { mail: { kind: 'email_verification', transport: mailer.transport, ...dispatch } },
            'mail dispatched',
          );
        }
      })
      .catch((err: unknown) => {
        metrics.mailMessages.inc({
          kind: 'email_verification',
          transport: mailer.transport,
          outcome: 'failed',
        });
        request.log.error({ err }, 'email verification mail failed');
      });
  }

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
      // A conflicting registration issues nothing and sends nothing: mailing
      // the account that already owns the address would let a stranger ping a
      // known mailbox at will by re-attempting a signup.
      if (!user) throw conflict('email_taken', 'An account with that email already exists');

      const { token, expiresAt } = await createSession(
        db,
        user.id,
        config.SESSION_TTL_HOURS,
        truncateUserAgent(request.headers['user-agent']),
      );
      setSessionCookie(reply, config, token, expiresAt);
      // The first row of every trail: "this account was created at T". After
      // the state change, never inside a transaction, and never fatal.
      await recordAuditEvent(request, db, metrics, {
        userId: user.id,
        action: 'auth.register',
        outcome: 'success',
      });
      await issueEmailVerification(request, user, 'issued');
      // A row this insert just created is unverified by construction.
      return reply.status(201).send({ ...user, emailVerified: false });
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
        .select({
          id: users.id,
          email: users.email,
          passwordHash: users.passwordHash,
          emailVerifiedAt: users.emailVerifiedAt,
        })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);

      const user = rows[0];
      // Always run a verification so response time does not reveal account existence.
      const digest = user?.passwordHash ?? DUMMY_HASH;
      const ok = await verifyPassword(digest, password);
      if (!user || !ok) {
        // ASYMMETRIC BY DESIGN, and the line a reviewer should push on first.
        // A failed attempt against a KNOWN address is the single highest-value
        // row in this feature — somebody is guessing this account's password —
        // and one against an unknown address writes nothing at all: there is no
        // account to own the row, so nobody could ever read it, and the only
        // way to make it meaningful would be to store the attempted address,
        // building a table of email addresses belonging to people who are NOT
        // users of this service. The response body and status code are
        // identical on both branches; the residual channel is timing, bounded
        // by the argon2 verification both branches run and by
        // AUTH_RATE_LIMIT_MAX. See the spec's enumeration-timing heading.
        if (user) {
          await recordAuditEvent(request, db, metrics, {
            userId: user.id,
            action: 'auth.login',
            outcome: 'failure',
          });
          // On failure too, not just success: the rows this table accumulates
          // fastest are written by whoever is attacking the account, so the
          // attacker's own traffic purges up to 100 expired rows per attempt.
          await sweepAuditEvents(request, db, metrics, user.id);
        }
        throw unauthorized('Invalid email or password');
      }

      const { token, expiresAt } = await createSession(
        db,
        user.id,
        config.SESSION_TTL_HOURS,
        truncateUserAgent(request.headers['user-agent']),
      );
      setSessionCookie(reply, config, token, expiresAt);
      // "Somebody signed in as me at T", answerable long after the session it
      // created has gone. Never fatal: the session already exists and the
      // cookie is already on the reply, so a 500 here would report an error for
      // an operation that succeeded (ADR 0024).
      await recordAuditEvent(request, db, metrics, {
        userId: user.id,
        action: 'auth.login',
        outcome: 'success',
      });
      await sweepAuditEvents(request, db, metrics, user.id);
      // Login is deliberately not gated on verification (ADR 0011); the state
      // is reported so a client can prompt, and nothing more.
      return reply.send({
        id: user.id,
        email: user.email,
        emailVerified: user.emailVerifiedAt !== null,
      });
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
      const token = generateRecoveryToken();
      const tokenHash = hashRecoveryToken(token);
      const expiresAt = recoveryTokenExpiry(config.PASSWORD_RESET_TTL_MINUTES);

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
            .then((dispatch) => {
              // See the same block in the verification path: `suppressed` is a
              // real outcome, and it must not be counted as delivered.
              const outcome = dispatch?.outcome ?? 'sent';
              metrics.mailMessages.inc({
                kind: 'password_reset',
                transport: mailer.transport,
                outcome,
              });
              if (dispatch) {
                request.log.info(
                  { mail: { kind: 'password_reset', transport: mailer.transport, ...dispatch } },
                  'mail dispatched',
                );
              }
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

        // Recorded for every request against a known address, including one
        // the 60-second cooldown swallowed: the event is "somebody asked to
        // reset my password and I did not", and the asking is what the account
        // owner needs to see. It reaches a victim who never receives the mail.
        // Outside the `issued` branch for exactly that reason, and inside the
        // `user` branch for the same reason the failed-sign-in row is: there is
        // no account to own a row for an address that matches nothing.
        await recordAuditEvent(request, db, metrics, {
          userId: user.id,
          action: 'password_reset.requested',
          outcome: 'success',
        });
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
        body: z.object({ token: RecoveryTokenSchema, password: z.string().min(12).max(200) }),
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
      const tokenHash = hashRecoveryToken(token);

      let resetUserId: string;
      try {
        resetUserId = await db.transaction(async (tx) => {
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
          // Returned, not audited here: the audit write goes after the
          // transaction commits, never inside it. Inside, a bookkeeping row
          // that would not insert could roll back a password change and a full
          // session purge — an audit log able to undo a security operation is a
          // new way to attack it (ADR 0024).
          return row.userId;
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
      // The credential changed and every session died with it. A rejected
      // token reaches neither this line nor the table: the throw above is the
      // only exit from the catch.
      await recordAuditEvent(request, db, metrics, {
        userId: resetUserId,
        action: 'password_reset.completed',
        outcome: 'success',
      });
      return reply.status(204).send(null);
    },
  );

  // Authenticated, so it can be honest: the caller already holds a session, so
  // a truthful 409 discloses nothing they do not already know. That is the
  // opposite of the public reset request above, and it only works because
  // login is not gated on verification (ADR 0011).
  r.post(
    '/api/auth/verify-email',
    {
      config: authRateLimit,
      preValidation: requireAuth,
      schema: {
        tags: ['auth'],
        // z.void(), not z.null(): the contract is an empty body, and z.null()
        // would serialise the four-byte body "null". Unlike a 204, a 202 does
        // not get its body stripped by the framework.
        // 401 is deliberately not declared — requireAuth raises it before
        // validation, and no declared schema means no serializer to strip it.
        response: { 202: z.void(), 409: ErrorResponse },
      },
    },
    async (request, reply) => {
      const user = request.user!;
      // Read off the session loader, before touching the database.
      if (user.emailVerified) {
        throw conflict('already_verified', 'That address is already verified');
      }

      await issueEmailVerification(request, user, 'resent');
      // 202 either way: inside the cooldown nothing is written and nothing is
      // sent, and the token the user already has stays valid.
      return reply.status(202).send();
    },
  );

  // Public by design: the link is opened in whatever browser the mail client
  // hands it to, routinely not the one holding the session. It creates no
  // session either — a mailbox token proves control of the mailbox, not of the
  // password, and minting a session from it would make it a second credential.
  // It verifies the account the token was issued for, never the caller's.
  r.post(
    '/api/auth/verify-email/confirm',
    {
      config: authRateLimit,
      schema: {
        tags: ['auth'],
        body: z.object({ token: RecoveryTokenSchema }),
        response: { 204: z.null(), 400: ErrorResponse },
      },
    },
    async (request, reply) => {
      const tokenHash = hashRecoveryToken(request.body.token);

      try {
        await db.transaction(async (tx) => {
          // Deleting IS the single-use check: one atomic statement, no
          // `used_at` column to forget, and two concurrent confirms cannot
          // both win. Served by the unique constraint on token_hash.
          const claimed = await tx
            .delete(emailVerificationTokens)
            .where(eq(emailVerificationTokens.tokenHash, tokenHash))
            .returning({
              userId: emailVerificationTokens.userId,
              expiresAt: emailVerificationTokens.expiresAt,
            });

          const row = claimed[0];
          if (!row) throw badRequest('invalid_token', 'That verification link is not valid');

          // Rolls the delete back, so the dead row survives to be overwritten
          // by the next resend. Distinguishing expired from unknown is safe:
          // only someone already holding a token can reach either answer.
          if (row.expiresAt.getTime() <= Date.now()) {
            throw badRequest('token_expired', 'That verification link has expired');
          }

          // Unconditional: only a valid live token reaches this line, and
          // re-verifying an already-verified account is not an error here.
          await tx
            .update(users)
            .set({ emailVerifiedAt: new Date(), updatedAt: new Date() })
            .where(eq(users.id, row.userId));
        });
      } catch (err) {
        // Only the two deliberate rejections are counted; an unexpected
        // database failure is a 500 and must not be recorded as a bad token.
        if (err instanceof AppError) {
          const outcome = err.code === 'token_expired' ? 'expired' : 'invalid';
          metrics.emailVerifications.inc({ outcome });
          // Outcome only — never the token, the address, or the user id.
          request.log.info({ emailVerification: { outcome } }, 'email verification rejected');
        }
        throw err;
      }

      metrics.emailVerifications.inc({ outcome: 'consumed' });
      request.log.info({ emailVerification: { outcome: 'consumed' } }, 'email verified');
      // No session is created, destroyed, or refreshed; no cookie is touched.
      return reply.status(204).send(null);
    },
  );
}

// argon2id digest of a random string, used only to equalise login timing.
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$3G0m3fLmA1cwyPzYb8yFwl0Q6oYQ0YQmXk2v3q3jH0E';
