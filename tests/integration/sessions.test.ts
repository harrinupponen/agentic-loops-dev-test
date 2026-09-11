import { sql } from 'drizzle-orm';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sessions } from '../../src/db/schema.js';
import { hashSessionToken } from '../../src/lib/session.js';
import {
  createTestContext,
  metricsAuth,
  registerUser,
  resetDb,
  type TestContext,
} from './helpers.js';

const PASSWORD = 'correct-horse-battery-staple';

interface SessionView {
  id: string;
  createdAt: string;
  expiresAt: string;
  userAgent: string | null;
  current: boolean;
}

interface SessionList {
  items: SessionView[];
  truncated: boolean;
}

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext({ AUTH_RATE_LIMIT_MAX: '10000' });
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await resetDb(ctx.db);
});

/** The opaque token inside a signed `sid=<token>.<signature>` cookie header. */
const tokenOf = (cookie: string) => cookie.slice('sid='.length).split('.')[0]!;

/** Logs in again as an existing account, yielding a second live session. */
async function login(app: TestContext['app'], email: string, userAgent?: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: PASSWORD },
    ...(userAgent === undefined ? {} : { headers: { 'user-agent': userAgent } }),
  });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const raw = res.headers['set-cookie'];
  return (Array.isArray(raw) ? raw[0]! : String(raw)).split(';')[0]!;
}

const list = (cookie: string) =>
  ctx.app.inject({ method: 'GET', url: '/api/auth/sessions', headers: { cookie } });

const me = (cookie: string) =>
  ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });

const revokeOne = (cookie: string, id: string) =>
  ctx.app.inject({ method: 'DELETE', url: `/api/auth/sessions/${id}`, headers: { cookie } });

const revokeOthers = (cookie: string) =>
  ctx.app.inject({ method: 'DELETE', url: '/api/auth/sessions', headers: { cookie } });

async function listed(cookie: string): Promise<SessionList> {
  const res = await list(cookie);
  expect(res.statusCode).toBe(200);
  return res.json<SessionList>();
}

/** Ages a session row so ORDER BY created_at DESC has a deterministic answer. */
function ageSession(cookie: string, seconds: number) {
  return ctx.db.execute(
    sql`UPDATE sessions SET created_at = now() - make_interval(secs => ${seconds})
        WHERE id = ${hashSessionToken(tokenOf(cookie))}`,
  );
}

describe('GET /api/auth/sessions', () => {
  it("lists the caller's sessions newest first", async () => {
    const { cookie: oldest, user } = await registerUser(ctx.app, 'lister@example.com');
    const older = await login(ctx.app, user.email);
    const current = await login(ctx.app, user.email);
    // Every row aged explicitly: `now()` is transaction time, so three rows
    // written back to back would otherwise leave ORDER BY ties to chance.
    await ageSession(oldest, 200);
    await ageSession(older, 120);
    await ageSession(current, 10);

    const body = await listed(current);

    // Three rows: registration's session plus the two logins.
    expect(body.items).toHaveLength(3);
    expect(body.truncated).toBe(false);

    const created = body.items.map((s) => Date.parse(s.createdAt));
    expect(created).toEqual([...created].sort((a, b) => b - a));

    const currents = body.items.filter((s) => s.current);
    expect(currents).toHaveLength(1);
    // The newest of the three is the one whose cookie made the request.
    expect(Date.parse(currents[0]!.createdAt)).toBe(Math.max(...created));
  });

  it('never returns the session token hash', async () => {
    const { user } = await registerUser(ctx.app, 'nohash@example.com');
    const second = await login(ctx.app, user.email);
    const res = await list(second);
    expect(res.statusCode).toBe(200);

    // Asserted against the raw serialised body, not the parsed object: an
    // undeclared key survives JSON.parse just as happily as it survives a
    // reviewer. The declared response schema is what strips it.
    expect(res.body).not.toContain(hashSessionToken(tokenOf(second)));
    const rows = await ctx.db.select({ id: sessions.id }).from(sessions);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(res.body).not.toContain(row.id);
  });

  it('expired sessions are not listed', async () => {
    const { cookie, user } = await registerUser(ctx.app, 'expiry@example.com');
    const dead = await login(ctx.app, user.email);
    await ctx.db.execute(
      sql`UPDATE sessions SET expires_at = now() - interval '1 hour'
          WHERE id = ${hashSessionToken(tokenOf(dead))}`,
    );

    const body = await listed(cookie);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.current).toBe(true);
  });

  it('the session list is capped and says so', async () => {
    const { cookie, user } = await registerUser(ctx.app, 'capped@example.com');
    const expiresAt = new Date(Date.now() + 3_600_000);
    const seed = (n: number, offset: number) =>
      ctx.db.insert(sessions).values(
        Array.from({ length: n }, (_, i) => ({
          id: hashSessionToken(`seed-${offset + i}`),
          userId: user.id,
          expiresAt,
        })),
      );

    await seed(99, 0); // 99 + the registration session = 100
    const at100 = await listed(cookie);
    expect(at100.items).toHaveLength(100);
    expect(at100.truncated).toBe(false);

    await seed(1, 99); // 101
    const at101 = await listed(cookie);
    expect(at101.items).toHaveLength(100);
    expect(at101.truncated).toBe(true);
  });
});

describe('user agent capture', () => {
  it('captures the user agent at sign-in', async () => {
    const { user } = await registerUser(ctx.app, 'agents@example.com');
    const caller = await login(ctx.app, user.email, 'AcmeBrowser/9.9');
    await login(ctx.app, user.email, 'z'.repeat(1000));
    // light-my-request always supplies a `user-agent` when the caller does
    // not, so an empty header is how the absent-header path is reached here.
    // It is the same branch: truncateUserAgent returns null for both.
    await login(ctx.app, user.email, '');

    const body = await listed(caller);
    const agents = body.items.map((s) => s.userAgent);

    expect(agents).toContain('AcmeBrowser/9.9');
    expect(agents).toContain(null);
    const truncated = agents.find((a) => a !== null && a.startsWith('zzz'));
    expect(truncated).toHaveLength(256);
  });

  it('a session with no captured device still works', async () => {
    const { cookie, user } = await registerUser(ctx.app, 'legacy@example.com');
    const legacy = await login(ctx.app, user.email, 'AcmeBrowser/9.9');
    // Simulates a row written before this feature shipped.
    await ctx.db.execute(
      sql`UPDATE sessions SET user_agent = NULL
          WHERE id = ${hashSessionToken(tokenOf(legacy))}`,
    );

    const row = (await listed(cookie)).items.find((s) => !s.current)!;
    expect(row.userAgent).toBeNull();

    expect((await revokeOne(cookie, row.id)).statusCode).toBe(204);
    expect((await me(legacy)).statusCode).toBe(401);
  });
});

describe('DELETE /api/auth/sessions/:id', () => {
  it('revokes one named session', async () => {
    const { cookie, user } = await registerUser(ctx.app, 'single@example.com');
    const other = await login(ctx.app, user.email);
    const target = (await listed(cookie)).items.find((s) => !s.current)!;

    const res = await revokeOne(cookie, target.id);
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect((await me(other)).statusCode).toBe(401);
    expect((await me(cookie)).statusCode).toBe(200);
  });

  it('revoking the current session logs it out', async () => {
    const { cookie } = await registerUser(ctx.app, 'selfrevoke@example.com');
    const current = (await listed(cookie)).items.find((s) => s.current)!;

    const res = await revokeOne(cookie, current.id);
    expect(res.statusCode).toBe(204);

    const setCookie = res.headers['set-cookie'];
    const raw = Array.isArray(setCookie) ? setCookie.join(' ') : String(setCookie);
    expect(raw).toContain('sid=');
    expect(raw).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/);
    expect((await me(cookie)).statusCode).toBe(401);
  });

  it('rejects a malformed id without truncating the error body', async () => {
    const { cookie } = await registerUser(ctx.app, 'malformed@example.com');
    const res = await revokeOne(cookie, 'not-a-uuid');

    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: { code: string; details?: { message: string }[] } }>();
    expect(body.error.code).toBe('validation_failed');
    // The declared 400 schema must keep `details`: the zod serializer strips
    // every key a response schema does not name.
    expect(Array.isArray(body.error.details)).toBe(true);
    expect(body.error.details!.length).toBeGreaterThan(0);
  });

  it('404s a public id that exists for nobody', async () => {
    const { cookie } = await registerUser(ctx.app, 'ghost@example.com');
    const res = await revokeOne(cookie, '00000000-0000-4000-8000-000000000000');
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('not_found');
  });
});

describe('cross-account isolation', () => {
  it("another user's session is neither listed nor revocable", async () => {
    const a = await registerUser(ctx.app, 'alice@example.com');
    const b = await registerUser(ctx.app, 'bob@example.com');

    const bSession = (await listed(b.cookie)).items[0]!;
    const aList = await listed(a.cookie);
    expect(aList.items).toHaveLength(1);
    expect(aList.items.map((s) => s.id)).not.toContain(bSession.id);

    // 404, not 403: a 403 confirms the id names something real.
    const res = await revokeOne(a.cookie, bSession.id);
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('not_found');
    expect((await me(b.cookie)).statusCode).toBe(200);
  });
});

describe('DELETE /api/auth/sessions', () => {
  it("signs out every other session and nobody else's", async () => {
    const a = await registerUser(ctx.app, 'sweeper@example.com');
    const other1 = await login(ctx.app, a.user.email);
    const other2 = await login(ctx.app, a.user.email);
    const b = await registerUser(ctx.app, 'bystander@example.com');
    const bSecond = await login(ctx.app, b.user.email);

    const res = await revokeOthers(a.cookie);
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');

    // The opposite of F-004: the caller keeps the device in their hand.
    expect((await me(a.cookie)).statusCode).toBe(200);
    expect((await me(other1)).statusCode).toBe(401);
    expect((await me(other2)).statusCode).toBe(401);
    expect((await listed(a.cookie)).items).toHaveLength(1);

    expect((await me(b.cookie)).statusCode).toBe(200);
    expect((await me(bSecond)).statusCode).toBe(200);
  });

  it('revoking others is a no-op at one session', async () => {
    const { cookie } = await registerUser(ctx.app, 'lonely@example.com');
    const before = (await listed(cookie)).items;

    const res = await revokeOthers(cookie);
    expect(res.statusCode).toBe(204);

    const after = (await listed(cookie)).items;
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(before[0]!.id);
    expect((await me(cookie)).statusCode).toBe(200);
  });
});

describe('authentication', () => {
  it('every session route requires authentication', async () => {
    const { cookie, user } = await registerUser(ctx.app, 'guard@example.com');
    const dead = await login(ctx.app, user.email);
    const doomed = (await listed(cookie)).items.find((s) => !s.current)!;
    expect((await revokeOne(cookie, doomed.id)).statusCode).toBe(204);

    const before = await ctx.db.select({ id: sessions.id }).from(sessions);

    // No cookie at all, and a cookie naming a session that was just deleted.
    for (const headers of [{}, { cookie: dead }]) {
      for (const call of [
        { method: 'GET' as const, url: '/api/auth/sessions' },
        { method: 'DELETE' as const, url: `/api/auth/sessions/${doomed.id}` },
        { method: 'DELETE' as const, url: '/api/auth/sessions' },
      ]) {
        const res = await ctx.app.inject({ ...call, headers });
        expect(res.statusCode).toBe(401);
        expect(res.json<{ error: { code: string } }>().error.code).toBe('unauthorized');
      }
    }

    const after = await ctx.db.select({ id: sessions.id }).from(sessions);
    expect(after.map((r) => r.id).sort()).toEqual(before.map((r) => r.id).sort());
  });
});

describe('operational surface', () => {
  it('session routes log no identifiers', async () => {
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
      const email = 'logscan-sessions@example.com';
      const { cookie } = await registerUser(logged.app, email);
      const agent = 'SuperSecretBrowser/1.0';
      const secondCookie = await login(logged.app, email, agent);

      const listRes = await logged.app.inject({
        method: 'GET',
        url: '/api/auth/sessions',
        headers: { cookie },
      });
      const target = listRes.json<SessionList>().items.find((s) => s.userAgent === agent)!;
      await logged.app.inject({
        method: 'DELETE',
        url: `/api/auth/sessions/${target.id}`,
        headers: { cookie },
      });
      await logged.app.inject({
        method: 'DELETE',
        url: '/api/auth/sessions',
        headers: { cookie },
      });

      const output = chunks.join('');
      expect(output.length).toBeGreaterThan(0); // the stream really is capturing
      expect(output).not.toContain(agent);
      expect(output).not.toContain(target.id);
      for (const c of [cookie, secondCookie]) {
        expect(output).not.toContain(tokenOf(c));
        expect(output).not.toContain(hashSessionToken(tokenOf(c)));
      }
    } finally {
      await logged.close();
    }
  });

  it('exposes session revocation counters', async () => {
    const { cookie, user } = await registerUser(ctx.app, 'counters@example.com');
    await login(ctx.app, user.email);
    await login(ctx.app, user.email);
    const target = (await listed(cookie)).items.find((s) => !s.current)!;

    const read = async () => {
      const res = await ctx.app.inject({ url: '/metrics', headers: metricsAuth() });
      const value = (scope: string) =>
        Number(
          new RegExp(`sessions_revoked_total\\{scope="${scope}"\\}\\s+(\\d+)`).exec(
            res.body,
          )?.[1] ?? 0,
        );
      return { body: res.body, single: value('single'), others: value('others') };
    };

    const before = await read();
    await revokeOne(cookie, target.id);
    await revokeOthers(cookie); // exactly one other row left to sweep
    const after = await read();

    expect(after.body).toContain('sessions_revoked_total');
    expect(after.single).toBe(before.single + 1);
    // `others` advances by the number of rows actually deleted, not by one call.
    expect(after.others).toBe(before.others + 1);
  });
});
