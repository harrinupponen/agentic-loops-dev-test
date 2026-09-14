import { eq, sql } from 'drizzle-orm';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditEvents, users } from '../../src/db/schema.js';
import type { Mailer } from '../../src/lib/mailer.js';
import { hashSessionToken } from '../../src/lib/session.js';
import {
  createTestContext,
  metricsAuth,
  registerUser,
  resetDb,
  type TestContext,
} from './helpers.js';

const PASSWORD = 'correct-horse-battery-staple';
const NEW_PASSWORD = 'entirely-different-passphrase';

interface AuditEventView {
  id: string;
  action: string;
  outcome: string;
  createdAt: string;
}

interface AuditList {
  items: AuditEventView[];
  nextCursor: string | null;
}

interface SentMessage {
  to: string;
  token: string;
  expiresAt: Date;
}

/** The only supported way to observe an outgoing message (ADR 0010). */
function recordingMailer() {
  const sent: SentMessage[] = [];
  const mailer: Mailer = {
    transport: 'test',
    sendPasswordReset: (message) => {
      sent.push(message);
      return Promise.resolve();
    },
    sendEmailVerification: () => Promise.resolve(),
  };
  return { mailer, sent };
}

let ctx: TestContext;
let sent: SentMessage[];

beforeAll(async () => {
  const recorder = recordingMailer();
  sent = recorder.sent;
  ctx = await createTestContext(
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

/** The opaque token inside a signed `sid=<token>.<signature>` cookie header. */
const tokenOf = (cookie: string) => cookie.slice('sid='.length).split('.')[0]!;

const cookieOf = (res: { headers: Record<string, string | string[] | number | undefined> }) => {
  const raw = res.headers['set-cookie'];
  return (Array.isArray(raw) ? raw[0]! : String(raw)).split(';')[0]!;
};

function login(email: string, password = PASSWORD) {
  return ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
}

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

const listEvents = (cookie?: string, query = '') =>
  ctx.app.inject({
    method: 'GET',
    url: `/api/auth/audit-events${query}`,
    ...(cookie ? { headers: { cookie } } : {}),
  });

async function listed(cookie: string, query = ''): Promise<AuditList> {
  const res = await listEvents(cookie, query);
  expect(res.statusCode).toBe(200);
  return res.json<AuditList>();
}

/** Every audit row in the table, oldest first, straight from the database. */
function allRows(userId?: string) {
  const q = ctx.db
    .select({
      id: auditEvents.id,
      userId: auditEvents.userId,
      action: auditEvents.action,
      outcome: auditEvents.outcome,
      createdAt: auditEvents.createdAt,
    })
    .from(auditEvents)
    .orderBy(auditEvents.createdAt);
  return userId ? q.where(eq(auditEvents.userId, userId)) : q;
}

const clearEvents = () => ctx.db.execute(sql`DELETE FROM audit_events`);

/** Seeds `count` rows one second apart so ORDER BY has a deterministic answer. */
function seedEvents(userId: string, count: number, action = 'auth.login') {
  const base = Date.now();
  return ctx.db.insert(auditEvents).values(
    Array.from({ length: count }, (_, i) => ({
      userId,
      action,
      outcome: 'success',
      createdAt: new Date(base - i * 1000),
    })),
  );
}

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);

function counterValue(body: string, name: string, labels: Record<string, string> = {}) {
  for (const line of body.split('\n')) {
    if (!line.startsWith(`${name}{`) && line !== `${name} 0` && !line.startsWith(`${name} `)) {
      continue;
    }
    if (Object.entries(labels).every(([k, v]) => line.includes(`${k}="${v}"`))) {
      return Number(line.slice(line.lastIndexOf(' ') + 1));
    }
  }
  return 0;
}

const readMetrics = async () => {
  const res = await ctx.app.inject({ url: '/metrics', headers: metricsAuth() });
  expect(res.statusCode).toBe(200);
  return res.body;
};

describe('recording security events', () => {
  it('registration is recorded', async () => {
    const { user } = await registerUser(ctx.app, 'register-audit@example.com');

    const rows = await allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: user.id,
      action: 'auth.register',
      outcome: 'success',
    });
  });

  it('a successful sign-in is recorded', async () => {
    const { user } = await registerUser(ctx.app, 'login-audit@example.com');
    await clearEvents();

    const res = await login(user.email);
    expect(res.statusCode).toBe(200);

    const rows = await allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: user.id,
      action: 'auth.login',
      outcome: 'success',
    });
  });

  it('a failed sign-in against a known account is recorded', async () => {
    const { user } = await registerUser(ctx.app, 'failed-known@example.com');
    await clearEvents();

    const res = await login(user.email, 'wrong-password-entirely');
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string; message: string } }>().error).toMatchObject({
      code: 'unauthorized',
      message: 'Invalid email or password',
    });

    const rows = await allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: user.id,
      action: 'auth.login',
      outcome: 'failure',
    });
  });

  it('a failed sign-in against an unknown account is not recorded', async () => {
    // A registered account exists, so an empty table proves the miss wrote
    // nothing rather than that the writer is off entirely.
    const { user } = await registerUser(ctx.app, 'present@example.com');
    const known = await login(user.email, 'wrong-password-entirely');
    await clearEvents();

    const unknown = await login('nobody-at-all@example.com', 'wrong-password-entirely');

    expect(unknown.statusCode).toBe(known.statusCode);
    // Byte-identical apart from the request id the error envelope carries.
    const strip = (body: string) => body.replace(/"requestId":"[^"]+"/, '');
    expect(strip(unknown.body)).toBe(strip(known.body));
    expect(await allRows()).toHaveLength(0);
  });

  it('a reset request is recorded only for a known account', async () => {
    const { user } = await registerUser(ctx.app, 'reset-request@example.com');
    await clearEvents();

    const knownRes = await requestReset(user.email);
    const unknownRes = await requestReset('never-registered@example.com');

    expect(knownRes.statusCode).toBe(202);
    expect(unknownRes.statusCode).toBe(202);

    const rows = await allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: user.id,
      action: 'password_reset.requested',
      outcome: 'success',
    });
  });

  it('a completed reset is recorded and a rejected one is not', async () => {
    const { user } = await registerUser(ctx.app, 'reset-confirm@example.com');
    await requestReset(user.email);
    const token = sent.at(-1)!.token;
    await clearEvents();

    const bad = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/confirm',
      payload: { token: 'a'.repeat(43), password: NEW_PASSWORD },
    });
    expect(bad.statusCode).toBe(400);
    expect(await allRows()).toHaveLength(0);

    const good = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/confirm',
      payload: { token, password: NEW_PASSWORD },
    });
    expect(good.statusCode).toBe(204);

    const rows = await allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: user.id,
      action: 'password_reset.completed',
      outcome: 'success',
    });
  });

  it('session revocations are recorded', async () => {
    const { cookie, user } = await registerUser(ctx.app, 'revoke-audit@example.com');
    const otherCookie = cookieOf(await login(user.email));
    const bystander = await registerUser(ctx.app, 'revoke-bystander@example.com');
    await clearEvents();

    const sessionList = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/sessions',
      headers: { cookie },
    });
    const target = sessionList
      .json<{ items: { id: string; current: boolean }[] }>()
      .items.find((s) => !s.current)!;

    expect(
      (
        await ctx.app.inject({
          method: 'DELETE',
          url: `/api/auth/sessions/${target.id}`,
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await ctx.app.inject({
          method: 'DELETE',
          url: '/api/auth/sessions',
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(204);

    const rows = await allRows();
    expect(rows.map((r) => r.action)).toEqual(['session.revoked', 'session.revoked_others']);
    for (const row of rows) {
      expect(row.userId).toBe(user.id);
      expect(row.outcome).toBe('success');
    }
    expect(await allRows(bystander.user.id)).toHaveLength(0);
    // The revoked session really is gone; the row outlives it.
    expect(
      (
        await ctx.app.inject({
          method: 'GET',
          url: '/api/auth/me',
          headers: { cookie: otherCookie },
        })
      ).statusCode,
    ).toBe(401);
  });

  it('logout is not recorded', async () => {
    const { cookie } = await registerUser(ctx.app, 'logout-audit@example.com');
    await clearEvents();

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(204);
    expect(await allRows()).toHaveLength(0);
  });

  it('todo operations are not recorded', async () => {
    const { cookie } = await registerUser(ctx.app, 'todo-audit@example.com');
    await clearEvents();

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/todos',
      headers: { cookie },
      payload: { title: 'audit nothing' },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json<{ id: string }>().id;

    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/todos/${id}`,
      headers: { cookie },
      payload: { completed: true },
    });
    await ctx.app.inject({ method: 'DELETE', url: `/api/todos/${id}`, headers: { cookie } });
    await ctx.app.inject({
      method: 'POST',
      url: `/api/todos/${id}/restore`,
      headers: { cookie },
    });

    expect(await allRows()).toHaveLength(0);
  });
});

describe('GET /api/auth/audit-events', () => {
  it("lists the caller's own events newest first", async () => {
    const { cookie, user } = await registerUser(ctx.app, 'list-audit@example.com');
    await login(user.email);

    const res = await listEvents(cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json<AuditList>();

    expect(body.items).toHaveLength(2);
    expect(body.items.map((e) => e.action)).toEqual(['auth.login', 'auth.register']);
    expect(body.nextCursor).toBeNull();

    const created = body.items.map((e) => Date.parse(e.createdAt));
    expect(created).toEqual([...created].sort((a, b) => b - a));

    for (const item of body.items) {
      expect(Object.keys(item).sort()).toEqual(['action', 'createdAt', 'id', 'outcome']);
      expect(item.outcome).toBe('success');
    }
    // Asserted against the raw serialised body, not the parsed object: an
    // undeclared key survives JSON.parse just as happily as it survives a
    // reviewer. The declared response schema is what strips it.
    expect(res.body).not.toContain('userId');
    expect(res.body).not.toContain(user.id);
  });

  it('the audit list never crosses accounts', async () => {
    const alice = await registerUser(ctx.app, 'alice-audit@example.com');
    const bob = await registerUser(ctx.app, 'bob-audit@example.com');
    await login(alice.user.email);
    await login(bob.user.email);

    const bobIds = (await allRows(bob.user.id)).map((r) => r.id).sort();
    const aliceList = await listed(alice.cookie);
    const bobList = await listed(bob.cookie);

    expect(bobList.items).toHaveLength(2);
    expect(bobList.items.map((e) => e.id).sort()).toEqual(bobIds);
    expect(aliceList.items.map((e) => e.id)).not.toContain(bobList.items[0]!.id);

    // A cursor is a timestamp, not a permission: borrowing Alice's selects a
    // different slice of Bob's own rows and nothing else.
    const aliceCursor = encodeURIComponent(aliceList.items[0]!.createdAt);
    const withAlices = await listed(bob.cookie, `?cursor=${aliceCursor}`);
    for (const item of withAlices.items) expect(bobIds).toContain(item.id);
  });

  it('the audit list pages by keyset cursor', async () => {
    const { cookie, user } = await registerUser(ctx.app, 'paging-audit@example.com');
    await clearEvents();
    await seedEvents(user.id, 3);

    const first = await listed(cookie, '?limit=2');
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await listed(cookie, `?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`);
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();

    const ids = [...first.items, ...second.items].map((e) => e.id);
    expect(new Set(ids).size).toBe(3);
  });

  it('the audit list validates its query and requires authentication', async () => {
    const { cookie } = await registerUser(ctx.app, 'validate-audit@example.com');

    for (const query of ['?limit=0', '?limit=101', '?cursor=banana']) {
      const res = await listEvents(cookie, query);
      expect(res.statusCode).toBe(400);
      const body = res.json<{ error: { code: string; details?: { message: string }[] } }>();
      expect(body.error.code).toBe('validation_failed');
      // The declared 400 schema must keep `details`: the zod serializer strips
      // every key a response schema does not name.
      expect(body.error.details!.length).toBeGreaterThan(0);
    }

    const anonymous = await listEvents();
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json<{ error: { code: string } }>().error.code).toBe('unauthorized');
  });

  it('an empty trail is an empty page', async () => {
    const { cookie } = await registerUser(ctx.app, 'empty-audit@example.com');
    await clearEvents();

    const res = await listEvents(cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json<AuditList>()).toEqual({ items: [], nextCursor: null });
  });
});

describe('a failed audit write never fails the request', () => {
  it('an unwritable audit table does not break sign-in', async () => {
    const { user } = await registerUser(ctx.app, 'unwritable@example.com');
    const before = counterValue(await readMetrics(), 'audit_write_failures_total');

    // The table is renamed for exactly one request, which is the only honest
    // way to make the insert fail without mocking the database away.
    await ctx.db.execute(sql`ALTER TABLE audit_events RENAME TO audit_events_hidden`);
    const res = await (async () => {
      try {
        return await login(user.email);
      } finally {
        await ctx.db.execute(sql`ALTER TABLE audit_events_hidden RENAME TO audit_events`);
      }
    })();

    // The security operation succeeded and the session it created works.
    expect(res.statusCode).toBe(200);
    const cookie = cookieOf(res);
    const me = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json<{ id: string }>().id).toBe(user.id);

    // The hole in the trail is visible in exactly one place.
    const after = counterValue(await readMetrics(), 'audit_write_failures_total');
    expect(after).toBe(before + 1);
  });
});

describe('retention', () => {
  it('retention sweeps expired events on both sign-in outcomes', async () => {
    const a = await registerUser(ctx.app, 'sweep-a@example.com');
    const b = await registerUser(ctx.app, 'sweep-b@example.com');
    await clearEvents();

    const seed = (userId: string, at: Date) =>
      ctx.db
        .insert(auditEvents)
        .values({ userId, action: 'auth.login', outcome: 'success', createdAt: at })
        .returning({ id: auditEvents.id });

    const [expiredA] = await seed(a.user.id, daysAgo(91));
    const [freshA] = await seed(a.user.id, daysAgo(89));
    const [expiredB] = await seed(b.user.id, daysAgo(91));

    // A failed sign-in sweeps too: the rows an attacked account accumulates are
    // written by the attacker, not by its owner.
    expect((await login(a.user.email, 'wrong-password-entirely')).statusCode).toBe(401);

    let ids = (await allRows()).map((r) => r.id);
    expect(ids).not.toContain(expiredA!.id);
    expect(ids).toContain(freshA!.id);
    // Caller-scoped: another account's expired row is not this caller's to purge.
    expect(ids).toContain(expiredB!.id);

    const [expiredAgain] = await seed(a.user.id, daysAgo(120));
    expect((await login(a.user.email)).statusCode).toBe(200);

    ids = (await allRows()).map((r) => r.id);
    expect(ids).not.toContain(expiredAgain!.id);
    expect(ids).toContain(freshA!.id);
    expect(ids).toContain(expiredB!.id);
  });

  it('audit events die with the account', async () => {
    const { user } = await registerUser(ctx.app, 'cascade-audit@example.com');
    const survivor = await registerUser(ctx.app, 'cascade-survivor@example.com');
    expect(await allRows(user.id)).toHaveLength(1);

    await ctx.db.delete(users).where(eq(users.id, user.id));

    expect(await allRows(user.id)).toHaveLength(0);
    expect(await allRows(survivor.user.id)).toHaveLength(1);
  });
});

describe('operational surface', () => {
  it('audit paths log no identifiers', async () => {
    const chunks: string[] = [];
    const logStream = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(String(chunk));
        cb();
      },
    });
    const logged = await createTestContext(
      { LOG_LEVEL: 'trace', AUTH_RATE_LIMIT_MAX: '10000' },
      { logStream },
    );
    try {
      await resetDb(logged.db);
      const email = 'logscan-audit@example.com';
      const agent = 'SuperSecretBrowser/1.0';
      const { cookie, user } = await registerUser(logged.app, email);
      await logged.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email, password: PASSWORD },
        headers: { 'user-agent': agent },
      });
      await logged.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email, password: 'wrong-password-entirely' },
      });
      const list = await logged.app.inject({
        method: 'GET',
        url: '/api/auth/audit-events',
        headers: { cookie },
      });
      expect(list.statusCode).toBe(200);

      const output = chunks.join('');
      expect(output.length).toBeGreaterThan(0); // the stream really is capturing
      expect(output).not.toContain(email);
      expect(output).not.toContain(agent);
      expect(output).not.toContain(user.id);
      expect(output).not.toContain(tokenOf(cookie));
      expect(output).not.toContain(hashSessionToken(tokenOf(cookie)));
      const publicIds = await logged.db.execute<{ public_id: string }>(
        sql`SELECT public_id FROM sessions`,
      );
      for (const row of publicIds.rows) expect(output).not.toContain(row.public_id);
    } finally {
      await logged.close();
    }
  });

  it('exposes audit counters', async () => {
    const { user } = await registerUser(ctx.app, 'counters-audit@example.com');
    const before = await readMetrics();
    const beforeSuccess = counterValue(before, 'audit_events_total', {
      action: 'auth.login',
      outcome: 'success',
    });
    const beforeFailure = counterValue(before, 'audit_events_total', {
      action: 'auth.login',
      outcome: 'failure',
    });
    const beforePurged = counterValue(before, 'audit_events_purged_total');

    await ctx.db.insert(auditEvents).values({
      userId: user.id,
      action: 'auth.login',
      outcome: 'success',
      createdAt: daysAgo(200),
    });
    await login(user.email);
    await login(user.email, 'wrong-password-entirely');

    const after = await readMetrics();
    expect(after).toContain('audit_events_total');
    expect(after).toContain('audit_write_failures_total');
    expect(after).toContain('audit_events_purged_total');
    expect(
      counterValue(after, 'audit_events_total', { action: 'auth.login', outcome: 'success' }),
    ).toBe(beforeSuccess + 1);
    expect(
      counterValue(after, 'audit_events_total', { action: 'auth.login', outcome: 'failure' }),
    ).toBe(beforeFailure + 1);
    // Advanced by the number of rows actually removed, so it carries how wide
    // each sweep was.
    expect(counterValue(after, 'audit_events_purged_total')).toBe(beforePurged + 1);
  });
});
