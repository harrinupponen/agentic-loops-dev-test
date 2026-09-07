import { eq, sql } from 'drizzle-orm';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { emailVerificationTokens, users } from '../../src/db/schema.js';
import type { Mailer } from '../../src/lib/mailer.js';
import { generateRecoveryToken, hashRecoveryToken } from '../../src/lib/recovery-token.js';
import {
  createTestContext,
  metricsAuth,
  registerUser,
  resetDb,
  type TestContext,
} from './helpers.js';

interface SentMessage {
  to: string;
  token: string;
  expiresAt: Date;
}

/**
 * The only supported way to observe an outgoing message (ADR 0010). There is no
 * test-only route that returns a token, by design.
 */
function recordingMailer(options: { failVerification?: boolean } = {}) {
  const sent: SentMessage[] = [];
  const mailer: Mailer = {
    transport: 'test',
    sendPasswordReset: () => Promise.resolve(),
    sendEmailVerification: (message) => {
      if (options.failVerification) {
        // Deliberately carries neither the address nor the token: a rejected
        // send is logged with `{ err }`, and the log-content rule applies.
        return Promise.reject(new Error('transport unavailable'));
      }
      sent.push(message);
      return Promise.resolve();
    },
  };
  return { mailer, sent };
}

const PASSWORD = 'correct-horse-battery-staple';

let ctx: TestContext;
let sent: SentMessage[];

/** The send is dispatched but not awaited, so give the microtask queue a turn. */
const flushMail = () => new Promise((resolve) => setImmediate(resolve));

async function signUp(email: string) {
  const result = await registerUser(ctx.app, email);
  await flushMail();
  return result;
}

function confirm(payload: Record<string, unknown>, headers: Record<string, string> = {}) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/auth/verify-email/confirm',
    payload,
    headers,
  });
}

async function resend(headers: Record<string, string> = {}) {
  const res = await ctx.app.inject({ method: 'POST', url: '/api/auth/verify-email', headers });
  await flushMail();
  return res;
}

function me(cookie: string) {
  return ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
}

function login(email: string, password = PASSWORD) {
  return ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
}

/** Ages the row past the 60-second per-account cooldown without sleeping. */
function expireCooldown(userId: string) {
  return ctx.db.execute(
    sql`UPDATE email_verification_tokens SET created_at = now() - interval '61 seconds' WHERE user_id = ${userId}`,
  );
}

async function verifiedAt(userId: string): Promise<Date | null> {
  const rows = await ctx.db
    .select({ at: users.emailVerifiedAt })
    .from(users)
    .where(eq(users.id, userId));
  return rows[0]!.at;
}

beforeAll(async () => {
  const recorder = recordingMailer();
  sent = recorder.sent;
  ctx = await createTestContext({ AUTH_RATE_LIMIT_MAX: '10000' }, { mailer: recorder.mailer });
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await resetDb(ctx.db);
  sent.length = 0;
});

describe('email verification — registration', () => {
  it('registration issues a verification token', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'signup@example.com', password: PASSWORD },
    });
    await flushMail();

    expect(res.statusCode).toBe(201);
    expect(res.headers['set-cookie']).toBeTruthy();

    const rows = await ctx.db.select().from(emailVerificationTokens);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(res.json<{ id: string }>().id);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('signup@example.com');
  });

  it('a duplicate registration does not mail the existing account', async () => {
    await signUp('taken@example.com');
    expect(sent).toHaveLength(1);

    const duplicate = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'taken@example.com', password: 'a-completely-different-one' },
    });
    await flushMail();

    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json<{ error: { code: string } }>().error.code).toBe('email_taken');
    // The second attempt must not ping the address that already owns the
    // account: no new row, no second message.
    expect(await ctx.db.select().from(emailVerificationTokens)).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it('a failed verification send does not fail signup', async () => {
    const recorder = recordingMailer({ failVerification: true });
    const broken = await createTestContext(
      { AUTH_RATE_LIMIT_MAX: '10000' },
      { mailer: recorder.mailer },
    );
    try {
      await resetDb(broken.db);
      const res = await broken.app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email: 'brokenmail@example.com', password: PASSWORD },
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(res.statusCode).toBe(201);
      const cookie = String(res.headers['set-cookie']).split(';')[0]!;
      const session = await broken.app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { cookie },
      });
      expect(session.statusCode).toBe(200);
      // The token was still issued; only delivery failed.
      expect(await broken.db.select().from(emailVerificationTokens)).toHaveLength(1);

      const metrics = await broken.app.inject({ url: '/metrics', headers: metricsAuth() });
      expect(metrics.body).toMatch(
        /mail_messages_total\{kind="email_verification",transport="test",outcome="failed"\}\s+[1-9]/,
      );
    } finally {
      await broken.close();
    }
  });

  it('stores only the hash of the verification token', async () => {
    const { user } = await signUp('hashonly@example.com');

    const raw = sent[0]!.token;
    expect(raw).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const rows = await ctx.db
      .select()
      .from(emailVerificationTokens)
      .where(eq(emailVerificationTokens.userId, user.id));
    const row = rows[0]!;
    expect(row.tokenHash).toBe(hashRecoveryToken(raw));
    // The raw token appears nowhere in the row, under any column.
    expect(JSON.stringify(row)).not.toContain(raw);
  });
});

describe('email verification — confirm', () => {
  it('consumes a token and marks the address verified', async () => {
    const { cookie, user } = await signUp('confirm@example.com');

    const res = await confirm({ token: sent[0]!.token });

    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(await verifiedAt(user.id)).toBeInstanceOf(Date);
    expect(await ctx.db.select().from(emailVerificationTokens)).toHaveLength(0);

    const after = await me(cookie);
    expect(after.json<{ emailVerified: boolean }>().emailVerified).toBe(true);
  });

  it('confirming needs no session and creates none', async () => {
    await signUp('nosession@example.com');

    // No cookie header at all.
    const res = await confirm({ token: sent[0]!.token });

    expect(res.statusCode).toBe(204);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('a verification token cannot be used twice', async () => {
    const { user } = await signUp('replay@example.com');
    const token = sent[0]!.token;

    expect((await confirm({ token })).statusCode).toBe(204);
    const first = await verifiedAt(user.id);

    const second = await confirm({ token });
    expect(second.statusCode).toBe(400);
    expect(second.json<{ error: { code: string } }>().error.code).toBe('invalid_token');
    // The timestamp from the legitimate use is untouched.
    expect((await verifiedAt(user.id))!.toISOString()).toBe(first!.toISOString());
  });

  it('an expired token is rejected with its own code', async () => {
    const { user } = await signUp('expired@example.com');
    const token = sent[0]!.token;
    await ctx.db
      .update(emailVerificationTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(emailVerificationTokens.userId, user.id));

    const res = await confirm({ token });

    expect(res.statusCode).toBe(400);
    // A code distinct from invalid_token.
    expect(res.json<{ error: { code: string } }>().error.code).toBe('token_expired');
    expect(await verifiedAt(user.id)).toBeNull();
    // The transaction rolled back, so the dead row survives to be overwritten.
    expect(await ctx.db.select().from(emailVerificationTokens)).toHaveLength(1);
  });

  it('an unknown verification token is rejected', async () => {
    const { user } = await signUp('unknown@example.com');

    const res = await confirm({ token: generateRecoveryToken() });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('invalid_token');
    expect(await verifiedAt(user.id)).toBeNull();
  });

  it('rejects malformed tokens without truncating the error body', async () => {
    for (const token of ['a'.repeat(42), 'a'.repeat(44), `${'a'.repeat(42)}/`]) {
      const res = await confirm({ token });
      expect(res.statusCode).toBe(400);
      const body = res.json<{ error: { code: string; details?: unknown[] }; requestId: string }>();
      expect(body.error.code).toBe('validation_failed');
      // The declared 400 schema must keep `details`; the zod serializer strips
      // any key the schema does not declare, which would silently gut this.
      expect(Array.isArray(body.error.details)).toBe(true);
      expect(body.error.details!.length).toBeGreaterThan(0);
      expect(body.requestId).toBeTruthy();
    }
  });

  it('a token verifies the account it was issued for, not the caller', async () => {
    const alice = await signUp('alice@example.com');
    const bob = await signUp('bob@example.com');
    const bobToken = sent.find((m) => m.to === 'bob@example.com')!.token;

    // Alice, signed in, submits Bob's token.
    const res = await confirm({ token: bobToken }, { cookie: alice.cookie });

    expect(res.statusCode).toBe(204);
    // Bob is verified — the token is Bob's proof of mailbox control.
    expect(await verifiedAt(bob.user.id)).toBeInstanceOf(Date);
    // Alice is not, and her session is untouched.
    expect(await verifiedAt(alice.user.id)).toBeNull();
    const aliceMe = await me(alice.cookie);
    expect(aliceMe.statusCode).toBe(200);
    expect(aliceMe.json<{ emailVerified: boolean }>().emailVerified).toBe(false);
  });
});

describe('email verification — resend', () => {
  it('resend requires a session', async () => {
    await signUp('needsauth@example.com');
    // Clear the row registration wrote, so "writes no row" is observable.
    await ctx.db.delete(emailVerificationTokens);
    sent.length = 0;

    const res = await resend();

    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('unauthorized');
    expect(await ctx.db.select().from(emailVerificationTokens)).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('resending invalidates the previous token', async () => {
    const { cookie, user } = await signUp('supersede@example.com');
    const firstToken = sent[0]!.token;
    await expireCooldown(user.id);

    const res = await resend({ cookie });

    expect(res.statusCode).toBe(202);
    expect(res.body).toBe('');
    expect(sent).toHaveLength(2);
    const secondToken = sent[1]!.token;
    expect(secondToken).not.toBe(firstToken);

    const rows = await ctx.db.select().from(emailVerificationTokens);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(hashRecoveryToken(secondToken));

    const replayed = await confirm({ token: firstToken });
    expect(replayed.statusCode).toBe(400);
    expect(replayed.json<{ error: { code: string } }>().error.code).toBe('invalid_token');
  });

  it('a resend inside the cooldown is silently ignored', async () => {
    const { cookie } = await signUp('cooldown@example.com');
    const firstToken = sent[0]!.token;

    const res = await resend({ cookie });

    expect(res.statusCode).toBe(202);
    expect(sent).toHaveLength(1); // no second message
    const rows = await ctx.db.select().from(emailVerificationTokens);
    expect(rows[0]!.tokenHash).toBe(hashRecoveryToken(firstToken));

    // and the first token is still usable
    expect((await confirm({ token: firstToken })).statusCode).toBe(204);
  });

  it('resending for a verified account is refused', async () => {
    const { cookie } = await signUp('already@example.com');
    expect((await confirm({ token: sent[0]!.token })).statusCode).toBe(204);
    sent.length = 0;

    const res = await resend({ cookie });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('already_verified');
    expect(await ctx.db.select().from(emailVerificationTokens)).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });
});

describe('email verification — advisory only (ADR 0011)', () => {
  it('verification state is visible on every user view', async () => {
    const registered = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'views@example.com', password: PASSWORD },
    });
    await flushMail();
    expect(registered.json<{ emailVerified: boolean }>().emailVerified).toBe(false);

    const cookie = String(registered.headers['set-cookie']).split(';')[0]!;
    const loggedIn = await login('views@example.com');
    expect(loggedIn.json<{ emailVerified: boolean }>().emailVerified).toBe(false);
    expect((await me(cookie)).json<{ emailVerified: boolean }>().emailVerified).toBe(false);

    expect((await confirm({ token: sent[0]!.token })).statusCode).toBe(204);

    expect(
      (await login('views@example.com')).json<{ emailVerified: boolean }>().emailVerified,
    ).toBe(true);
    expect((await me(cookie)).json<{ emailVerified: boolean }>().emailVerified).toBe(true);
  });

  it('an unverified account keeps full access', async () => {
    const { cookie, user } = await signUp('unverified@example.com');
    expect(await verifiedAt(user.id)).toBeNull();

    // Login is not gated.
    const loggedIn = await login('unverified@example.com');
    expect(loggedIn.statusCode).toBe(200);
    const freshCookie = String(loggedIn.headers['set-cookie']).split(';')[0]!;

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/todos',
      headers: { cookie: freshCookie },
      payload: { title: 'still allowed' },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json<{ id: string }>().id;

    const list = await ctx.app.inject({ url: '/api/todos', headers: { cookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ items: unknown[] }>().items).toHaveLength(1);

    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/todos/${id}`,
      headers: { cookie },
      payload: { completed: true },
    });
    expect(patched.statusCode).toBe(200);

    const removed = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/todos/${id}`,
      headers: { cookie },
    });
    expect(removed.statusCode).toBe(204);

    // Password reset works for an unverified address too.
    const reset = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/password-reset',
      payload: { email: 'unverified@example.com' },
    });
    expect(reset.statusCode).toBe(202);

    // Still unverified after all of it: nothing verified them as a side effect.
    expect(await verifiedAt(user.id)).toBeNull();
  });
});

describe('email verification — operational surface', () => {
  it('neither the verification token nor the address is ever logged', async () => {
    const chunks: string[] = [];
    const logStream = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(String(chunk));
        cb();
      },
    });
    const recorder = recordingMailer();
    const logged = await createTestContext(
      { LOG_LEVEL: 'trace', AUTH_RATE_LIMIT_MAX: '10000' },
      { mailer: recorder.mailer, logStream },
    );
    try {
      await resetDb(logged.db);
      const email = 'logscan@example.com';
      const registered = await logged.app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email, password: PASSWORD },
      });
      await new Promise((resolve) => setImmediate(resolve));
      const cookie = String(registered.headers['set-cookie']).split(';')[0]!;
      const userId = registered.json<{ id: string }>().id;

      await logged.db.execute(
        sql`UPDATE email_verification_tokens SET created_at = now() - interval '61 seconds' WHERE user_id = ${userId}`,
      );
      const resent = await logged.app.inject({
        method: 'POST',
        url: '/api/auth/verify-email',
        headers: { cookie },
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(resent.statusCode).toBe(202);

      const token = recorder.sent.at(-1)!.token;
      const confirmed = await logged.app.inject({
        method: 'POST',
        url: '/api/auth/verify-email/confirm',
        payload: { token },
      });
      expect(confirmed.statusCode).toBe(204);

      const output = chunks.join('');
      expect(output.length).toBeGreaterThan(0); // the stream really is capturing
      for (const secret of recorder.sent.map((m) => m.token)) {
        expect(output).not.toContain(secret);
      }
      expect(output).not.toContain(email);
    } finally {
      await logged.close();
    }
  });

  it('the drop transport keeps the flow intact', async () => {
    const dropped = await createTestContext({
      MAIL_TRANSPORT: 'drop',
      AUTH_RATE_LIMIT_MAX: '10000',
    });
    try {
      await resetDb(dropped.db);
      const registered = await dropped.app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email: 'dark@example.com', password: PASSWORD },
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(registered.statusCode).toBe(201);
      const userId = registered.json<{ id: string }>().id;
      expect(await dropped.db.select().from(emailVerificationTokens)).toHaveLength(1);

      // Nothing was delivered, so the raw token is unobtainable by design. Seed
      // a known hash to prove the confirm route still works under `drop`.
      const token = generateRecoveryToken();
      await dropped.db
        .update(emailVerificationTokens)
        .set({ tokenHash: hashRecoveryToken(token) })
        .where(eq(emailVerificationTokens.userId, userId));

      const confirmed = await dropped.app.inject({
        method: 'POST',
        url: '/api/auth/verify-email/confirm',
        payload: { token },
      });
      expect(confirmed.statusCode).toBe(204);

      const metrics = await dropped.app.inject({ url: '/metrics', headers: metricsAuth() });
      expect(metrics.body).toMatch(
        /mail_messages_total\{kind="email_verification",transport="drop",outcome="sent"\}\s+[1-9]/,
      );
    } finally {
      await dropped.close();
    }
  });

  it('exposes email verification counters', async () => {
    const { cookie, user } = await signUp('counters@example.com');
    await expireCooldown(user.id);
    expect((await resend({ cookie })).statusCode).toBe(202);
    const token = sent.at(-1)!.token;

    await confirm({ token: generateRecoveryToken() }); // invalid
    await ctx.db
      .update(emailVerificationTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(emailVerificationTokens.userId, user.id));
    await confirm({ token }); // expired
    await ctx.db
      .update(emailVerificationTokens)
      .set({ expiresAt: new Date(Date.now() + 600_000) })
      .where(eq(emailVerificationTokens.userId, user.id));
    await confirm({ token }); // consumed

    const metrics = await ctx.app.inject({ url: '/metrics', headers: metricsAuth() });
    const body = metrics.body;

    expect(body).toContain('email_verification_total');
    for (const outcome of ['issued', 'resent', 'consumed', 'expired', 'invalid']) {
      expect(body).toMatch(
        new RegExp(`email_verification_total\\{outcome="${outcome}"\\}\\s+[1-9]`),
      );
    }
  });
});
