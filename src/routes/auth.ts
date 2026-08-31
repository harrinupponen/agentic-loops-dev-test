import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Database } from '../db/client.js';
import { users } from '../db/schema.js';
import { conflict, unauthorized } from '../lib/errors.js';
import { SESSION_COOKIE } from '../lib/session.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
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

export function registerAuthRoutes(app: FastifyInstance, db: Database, config: Config) {
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
}

// argon2id digest of a random string, used only to equalise login timing.
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$3G0m3fLmA1cwyPzYb8yFwl0Q6oYQ0YQmXk2v3q3jH0E';
