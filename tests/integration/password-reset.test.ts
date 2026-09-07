import { eq, sql } from 'drizzle-orm';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { passwordResetTokens } from '../../src/db/schema.js';
import type { Mailer } from '../../src/lib/mailer.js';
import { generateResetToken, hashResetToken } from '../../src/lib/reset-token.js';
import { createTestContext, registerUser, resetDb, type TestContext } from './helpers.js';

interface SentMessage {
  to: string;
  token: string;
  expiresAt: Date;
}

/**
 * The only supported way to observe an outgoing message (ADR 0010). There is no
 * test-only route that returns a token, by design.
 */
function recordingMailer() {
  const sent: SentMessage[] = [];
  const mailer: Mailer = {
    transport: 'test',
    sendPasswordReset: (message) => {
      sent.push(message);
      return Promise.resolve();
    },
  };
  return { mailer, sent };
}

const PASSWORD = 'correct-horse-battery-staple';
const NEW_PASSWORD = 'entirely-different-passphrase';

let ctx: TestContext;
let sent: SentMessage[];

/** The send is dispatched but not awaited, so give the microtask queue a turn. */
const flushMail = () => new Promise((resolve) => setImmediate(resolve));

async function requestReset(email: string) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/password-reset',
    payload: { email },
  });
  await flushMail();
  return res;
}

function confirmReset(payload: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/auth/password-reset/confirm',
    payload,
  });
}

function login(app: TestContext['app'], email: string, password: string) {
  return app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
}

/** Ages the row past the 60-second per-account cooldown without sleeping. */
function expireCooldown(userId: string) {
  return ctx.db.execute(
    sql`UPDATE password_reset_tokens SET created_at = now() - interval '61 seconds' WHERE user_id = ${userId}`,
  );
}

beforeAll(async () => {
  const recorder = recordingMailer();
  sent = recorder.sent;
  ctx = await createTestContext(
    // Both limits are exercised by their own dedicated contexts below; here they
    // must not fire, or an unrelated case turns red because of test ordering.
    { AUTH_RATE_LIMIT_MAX: '10000', PASSWORD_RESET_RATE_LIMIT_MAX: '10000' },
    { mailer: recorder.mailer },
  );
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await resetDb(ctx.db);
  sent.length = 0;
});

describe('password reset — request', () => {
  it('issues a token for a known address', async () => {
    const { user } = await registerUser(ctx.app, 'known@example.com');

    const res = await requestReset('known@example.com');

    expect(res.statusCode).toBe(202);
    expect(res.body).toBe('');

    const rows = await ctx.db.select().from(passwordResetTokens);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(user.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('known@example.com');
  });

  it('an unknown address is indistinguishable from a known one', async () => {
    await registerUser(ctx.app, 'real@example.com');

    const known = await requestReset('real@example.com');
    const unknown = await requestReset('ghost@example.com');

    expect(unknown.statusCode).toBe(known.statusCode);
    expect(unknown.body).toBe(known.body);
    // Identical headers too, modulo the per-request id and timing.
    const headerNames = (res: typeof known) => Object.keys(res.headers).sort();
    expect(headerNames(unknown)).toEqual(headerNames(known));
    expect(unknown.headers['content-type']).toBe(known.headers['content-type']);
    expect(unknown.headers['set-cookie']).toBeUndefined();

    // The unknown branch writes nothing and mails nothing.
    const rows = await ctx.db.select().from(passwordResetTokens);
    expect(rows).toHaveLength(1);
    expect(sent.map((m) => m.to)).toEqual(['real@example.com']);
  });

  it('stores only the hash of the token', async () => {
    const { user } = await registerUser(ctx.app, 'hash@example.com');
    await requestReset('hash@example.com');

    const raw = sent[0]!.token;
    expect(raw).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const rows = await ctx.db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, user.id));
    const row = rows[0]!;
    expect(row.tokenHash).toBe(hashResetToken(raw));
    // The raw token appears nowhere in the row, under any column.
    expect(JSON.stringify(row)).not.toContain(raw);
  });

  it('a second request inside the cooldown is silently ignored', async () => {
    await registerUser(ctx.app, 'cooldown@example.com');
    await requestReset('cooldown@example.com');
    const firstToken = sent[0]!.token;

    const second = await requestReset('cooldown@example.com');

    expect(second.statusCode).toBe(202);
    expect(sent).toHaveLength(1); // no second message
    const rows = await ctx.db.select().from(passwordResetTokens);
    expect(rows[0]!.tokenHash).toBe(hashResetToken(firstToken));

    // and the first token is still usable
    expect((await confirmReset({ token: firstToken, password: NEW_PASSWORD })).statusCode).toBe(
      204,
    );
  });

  it('issuing a new token invalidates the previous one', async () => {
    const { user } = await registerUser(ctx.app, 'supersede@example.com');
    await requestReset('supersede@example.com');
    const firstToken = sent[0]!.token;

    await expireCooldown(user.id);
    await requestReset('supersede@example.com');
    const secondToken = sent[1]!.token;
    expect(secondToken).not.toBe(firstToken);

    const rows = await ctx.db.select().from(passwordResetTokens);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(hashResetToken(secondToken));

    const replayed = await confirmReset({ token: firstToken, password: NEW_PASSWORD });
    expect(replayed.statusCode).toBe(400);
    expect(replayed.json<{ error: { code: string } }>().error.code).toBe('invalid_token');
  });

  it('the reset request endpoint has its own tighter limit', async () => {
    const recorder = recordingMailer();
    const limited = await createTestContext(
      { PASSWORD_RESET_RATE_LIMIT_MAX: '1', AUTH_RATE_LIMIT_MAX: '10' },
      { mailer: recorder.mailer },
    );
    try {
      await resetDb(limited.db);
      await registerUser(limited.app, 'limited@example.com');

      const first = await limited.app.inject({
        method: 'POST',
        url: '/api/auth/password-reset',
        payload: { email: 'limited@example.com' },
      });
      const second = await limited.app.inject({
        method: 'POST',
        url: '/api/auth/password-reset',
        payload: { email: 'limited@example.com' },
      });

      expect(first.statusCode).toBe(202);
      expect(second.statusCode).toBe(429);
      expect(second.json<{ error: { code: string } }>().error.code).toBe('rate_limited');

      // Independent budget: login is untouched by the reset limit.
      const stillWorks = await login(limited.app, 'limited@example.com', PASSWORD);
      expect(stillWorks.statusCode).toBe(200);
    } finally {
      await limited.close();
    }
  });
});

describe('password reset — confirm', () => {
  it('consumes a token and sets the new password', async () => {
    await registerUser(ctx.app, 'consume@example.com');
    await requestReset('consume@example.com');

    const res = await confirmReset({ token: sent[0]!.token, password: NEW_PASSWORD });

    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(await ctx.db.select().from(passwordResetTokens)).toHaveLength(0);
    expect((await login(ctx.app, 'consume@example.com', NEW_PASSWORD)).statusCode).toBe(200);
    expect((await login(ctx.app, 'consume@example.com', PASSWORD)).statusCode).toBe(401);
  });

  it('a token cannot be used twice', async () => {
    await registerUser(ctx.app, 'replay@example.com');
    await requestReset('replay@example.com');
    const token = sent[0]!.token;

    expect((await confirmReset({ token, password: NEW_PASSWORD })).statusCode).toBe(204);

    const second = await confirmReset({ token, password: 'a-third-distinct-password' });
    expect(second.statusCode).toBe(400);
    expect(second.json<{ error: { code: string } }>().error.code).toBe('invalid_token');
    // The password from the first (legitimate) use still stands.
    expect((await login(ctx.app, 'replay@example.com', NEW_PASSWORD)).statusCode).toBe(200);
    expect(
      (await login(ctx.app, 'replay@example.com', 'a-third-distinct-password')).statusCode,
    ).toBe(401);
  });

  it('an expired token is rejected with its own code', async () => {
    const { user } = await registerUser(ctx.app, 'expired@example.com');
    await requestReset('expired@example.com');
    const token = sent[0]!.token;
    await ctx.db
      .update(passwordResetTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(passwordResetTokens.userId, user.id));

    const res = await confirmReset({ token, password: NEW_PASSWORD });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('token_expired');
    // Distinct from the unknown-token code, and the password is unchanged.
    expect((await login(ctx.app, 'expired@example.com', PASSWORD)).statusCode).toBe(200);
    // The transaction rolled back, so the dead row survives to be overwritten.
    expect(await ctx.db.select().from(passwordResetTokens)).toHaveLength(1);
  });

  it('an unknown token is rejected', async () => {
    await registerUser(ctx.app, 'unknown@example.com');

    const res = await confirmReset({ token: generateResetToken(), password: NEW_PASSWORD });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('invalid_token');
    expect((await login(ctx.app, 'unknown@example.com', PASSWORD)).statusCode).toBe(200);
  });

  it('a password change invalidates every session for that user only', async () => {
    const a1 = await registerUser(ctx.app, 'victim@example.com');
    const a2 = await login(ctx.app, 'victim@example.com', PASSWORD);
    const secondCookie = String(a2.headers['set-cookie']).split(';')[0]!;
    const other = await registerUser(ctx.app, 'bystander@example.com');

    await requestReset('victim@example.com');
    expect((await confirmReset({ token: sent[0]!.token, password: NEW_PASSWORD })).statusCode).toBe(
      204,
    );

    const me = (cookie: string) =>
      ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect((await me(a1.cookie)).statusCode).toBe(401);
    expect((await me(secondCookie)).statusCode).toBe(401);

    // Another user's resource: B's session and B's password both survive A's reset.
    expect((await me(other.cookie)).statusCode).toBe(200);
    expect((await login(ctx.app, 'bystander@example.com', PASSWORD)).statusCode).toBe(200);
    expect((await login(ctx.app, 'bystander@example.com', NEW_PASSWORD)).statusCode).toBe(401);
  });

  it('a reset does not sign the user in', async () => {
    await registerUser(ctx.app, 'nosession@example.com');
    await requestReset('nosession@example.com');

    const res = await confirmReset({ token: sent[0]!.token, password: NEW_PASSWORD });

    expect(res.statusCode).toBe(204);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('rejects malformed input without truncating the error body', async () => {
    const bad = [
      { token: 'a'.repeat(42), password: NEW_PASSWORD },
      { token: 'a'.repeat(44), password: NEW_PASSWORD },
      { token: `${'a'.repeat(42)}/`, password: NEW_PASSWORD },
      { token: generateResetToken(), password: 'short' },
    ];

    for (const payload of bad) {
      const res = await confirmReset(payload);
      expect(res.statusCode).toBe(400);
      const body = res.json<{ error: { code: string; details?: unknown[] }; requestId: string }>();
      expect(body.error.code).toBe('validation_failed');
      // The declared 400 schema must keep `details`; the zod serializer strips
      // any key the schema does not declare, which would silently gut this.
      expect(Array.isArray(body.error.details)).toBe(true);
      expect(body.error.details!.length).toBeGreaterThan(0);
      expect(body.requestId).toBeTruthy();
    }

    const malformedEmail = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/password-reset',
      payload: { email: 'not-an-email' },
    });
    expect(malformedEmail.statusCode).toBe(400);
    const body = malformedEmail.json<{ error: { code: string; details?: unknown[] } }>();
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.details!.length).toBeGreaterThan(0);
  });

  it('both routes are public and neither sets a cookie', async () => {
    await registerUser(ctx.app, 'public@example.com');

    // No session cookie is sent, and neither route answers 401.
    const request = await requestReset('public@example.com');
    const confirm = await confirmReset({ token: sent[0]!.token, password: NEW_PASSWORD });

    expect(request.statusCode).toBe(202);
    expect(confirm.statusCode).toBe(204);
    expect(request.headers['set-cookie']).toBeUndefined();
    expect(confirm.headers['set-cookie']).toBeUndefined();
  });
});

describe('password reset — operational surface', () => {
  it('neither the token nor the address is ever logged', async () => {
    const chunks: string[] = [];
    const logStream = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(String(chunk));
        cb();
      },
    });
    const recorder = recordingMailer();
    const logged = await createTestContext(
      { LOG_LEVEL: 'trace', AUTH_RATE_LIMIT_MAX: '10000', PASSWORD_RESET_RATE_LIMIT_MAX: '10000' },
      { mailer: recorder.mailer, logStream },
    );
    try {
      await resetDb(logged.db);
      const email = 'logscan@example.com';
      await registerUser(logged.app, email);
      await logged.app.inject({
        method: 'POST',
        url: '/api/auth/password-reset',
        payload: { email },
      });
      await new Promise((resolve) => setImmediate(resolve));
      const token = recorder.sent[0]!.token;
      const confirm = await logged.app.inject({
        method: 'POST',
        url: '/api/auth/password-reset/confirm',
        payload: { token, password: NEW_PASSWORD },
      });
      expect(confirm.statusCode).toBe(204);

      const output = chunks.join('');
      expect(output.length).toBeGreaterThan(0); // the stream really is capturing
      expect(output).not.toContain(token);
      expect(output).not.toContain(email);
    } finally {
      await logged.close();
    }
  });

  it('the console mail transport refuses to run in production', async () => {
    await expect(
      createTestContext({ NODE_ENV: 'production', MAIL_TRANSPORT: 'console' }),
    ).rejects.toThrow(/console.*production|production.*console/i);

    for (const NODE_ENV of ['development', 'test']) {
      const ok = await createTestContext({ NODE_ENV, MAIL_TRANSPORT: 'console' });
      await ok.close();
    }
  });

  it('the drop transport keeps the API surface intact', async () => {
    const dropped = await createTestContext({
      MAIL_TRANSPORT: 'drop',
      PASSWORD_RESET_RATE_LIMIT_MAX: '10000',
      AUTH_RATE_LIMIT_MAX: '10000',
    });
    try {
      await resetDb(dropped.db);
      const { user } = await registerUser(dropped.app, 'dark@example.com');

      const request = await dropped.app.inject({
        method: 'POST',
        url: '/api/auth/password-reset',
        payload: { email: 'dark@example.com' },
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(request.statusCode).toBe(202);
      expect(await dropped.db.select().from(passwordResetTokens)).toHaveLength(1);

      // Nothing was delivered, so the raw token is unobtainable by design. Seed
      // a known hash to prove the confirm route still works under `drop`.
      const token = generateResetToken();
      await dropped.db
        .update(passwordResetTokens)
        .set({ tokenHash: hashResetToken(token) })
        .where(eq(passwordResetTokens.userId, user.id));

      const confirm = await dropped.app.inject({
        method: 'POST',
        url: '/api/auth/password-reset/confirm',
        payload: { token, password: NEW_PASSWORD },
      });
      expect(confirm.statusCode).toBe(204);

      const metrics = await dropped.app.inject({ url: '/metrics' });
      expect(metrics.body).toMatch(
        /mail_messages_total\{[^}]*transport="drop"[^}]*\}\s+([1-9]\d*)/,
      );
    } finally {
      await dropped.close();
    }
  });

  it('exposes password reset counters', async () => {
    const { user } = await registerUser(ctx.app, 'metrics@example.com');
    await requestReset('metrics@example.com');
    const token = sent[0]!.token;

    await confirmReset({ token: generateResetToken(), password: NEW_PASSWORD }); // invalid
    await ctx.db
      .update(passwordResetTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(passwordResetTokens.userId, user.id));
    await confirmReset({ token, password: NEW_PASSWORD }); // expired
    await ctx.db
      .update(passwordResetTokens)
      .set({ expiresAt: new Date(Date.now() + 600_000) })
      .where(eq(passwordResetTokens.userId, user.id));
    await confirmReset({ token, password: NEW_PASSWORD }); // consumed

    const metrics = await ctx.app.inject({ url: '/metrics' });
    const body = metrics.body;

    expect(body).toContain('password_reset_total');
    for (const outcome of ['requested', 'consumed', 'expired', 'invalid']) {
      expect(body).toMatch(new RegExp(`password_reset_total\\{outcome="${outcome}"\\}\\s+[1-9]`));
    }
    expect(body).toMatch(
      /mail_messages_total\{kind="password_reset",transport="[a-z]+",outcome="sent"\}\s+[1-9]/,
    );
  });

  it('the request counter does not distinguish known addresses', async () => {
    await registerUser(ctx.app, 'counted@example.com');

    const read = async () => {
      const res = await ctx.app.inject({ url: '/metrics' });
      const match = /password_reset_total\{outcome="requested"\}\s+(\d+)/.exec(res.body);
      return match ? Number(match[1]) : 0;
    };

    const start = await read();
    await requestReset('counted@example.com');
    const afterKnown = await read();
    await requestReset('nobody-at-all@example.com');
    const afterUnknown = await read();

    // Same increment on both branches: the counter is not an enumeration oracle.
    expect(afterKnown - start).toBe(1);
    expect(afterUnknown - afterKnown).toBe(1);
  });
});
