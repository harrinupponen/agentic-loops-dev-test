import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { requestFingerprint } from '../../src/lib/idempotency.js';
import { createTestContext, registerUser, resetDb, type TestContext } from './helpers.js';

let ctx: TestContext;

beforeAll(async () => {
  // This suite registers more users than the default auth limit allows; the
  // limiter itself is covered by rate-limit.test.ts.
  ctx = await createTestContext({ AUTH_RATE_LIMIT_MAX: '1000' });
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await resetDb(ctx.db);
});

const KEY = 'idem-key-0000000001';

function post(cookie: string, title: string, key?: string) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/todos',
    headers: key ? { cookie, 'idempotency-key': key } : { cookie },
    payload: { title },
  });
}

async function listTitles(cookie: string) {
  const res = await ctx.app.inject({ url: '/api/todos', headers: { cookie } });
  return res.json<{ items: { id: string; title: string }[] }>().items;
}

type IdemRow = {
  key: string;
  fingerprint: string;
  status: string;
  response_status: number | null;
  response_body: { id: string } | null;
};

async function records(userId?: string) {
  const res = await ctx.db.execute<IdemRow>(
    userId
      ? sql`SELECT * FROM idempotency_keys WHERE user_id = ${userId} ORDER BY key`
      : sql`SELECT * FROM idempotency_keys ORDER BY key`,
  );
  return res.rows;
}

/** Seeds a record directly so lease/expiry cases have no timing race. */
function seed(opts: {
  userId: string;
  key: string;
  fingerprint: string;
  status: 'in_progress' | 'completed';
  ageSeconds: number;
  expiresInSeconds: number;
  responseBody?: unknown;
}) {
  return ctx.db.execute(sql`
    INSERT INTO idempotency_keys
      (user_id, key, fingerprint, status, response_status, response_body, created_at, expires_at)
    VALUES (
      ${opts.userId}, ${opts.key}, ${opts.fingerprint}, ${opts.status},
      ${opts.responseBody ? 201 : null},
      ${opts.responseBody ? JSON.stringify(opts.responseBody) : null}::jsonb,
      now() - make_interval(secs => ${opts.ageSeconds}),
      now() + make_interval(secs => ${opts.expiresInSeconds})
    )`);
}

describe('idempotency keys on POST /api/todos', () => {
  it('creates a todo and stores the outcome', async () => {
    const { cookie, user } = await registerUser(ctx.app);

    const res = await post(cookie, 'buy milk', KEY);
    expect(res.statusCode).toBe(201);
    expect(res.headers['idempotency-replayed']).toBeUndefined();
    expect(await listTitles(cookie)).toHaveLength(1);

    const stored = await records(user.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ key: KEY, status: 'completed', response_status: 201 });
    expect(stored[0]!.response_body!.id).toBe(res.json<{ id: string }>().id);
  });

  it('replays the stored response', async () => {
    const { cookie } = await registerUser(ctx.app);

    const first = await post(cookie, 'buy milk', KEY);
    const second = await post(cookie, 'buy milk', KEY);

    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(second.body).toBe(first.body);
    expect(await listTitles(cookie)).toHaveLength(1);
  });

  it('rejects a reused key with a different body', async () => {
    const { cookie } = await registerUser(ctx.app);
    await post(cookie, 'buy milk', KEY);

    const res = await post(cookie, 'buy bread', KEY);
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string }; requestId: string }>()).toMatchObject({
      error: { code: 'idempotency_key_reuse' },
    });
    expect(res.json<{ requestId: string }>().requestId).toBeTruthy();

    const titles = await listTitles(cookie);
    expect(titles.map((t) => t.title)).toEqual(['buy milk']);
  });

  it('idempotency keys are scoped per user', async () => {
    const alice = await registerUser(ctx.app, 'alice@example.com');
    const bob = await registerUser(ctx.app, 'bob@example.com');

    const first = await post(alice.cookie, 'alice note', KEY);
    const second = await post(bob.cookie, 'bob note', KEY);

    expect(first.statusCode).toBe(201);
    // Same key value, different owner: no 409, no replay, no cross-visibility.
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotency-replayed']).toBeUndefined();
    expect(second.json<{ id: string }>().id).not.toBe(first.json<{ id: string }>().id);

    expect((await listTitles(alice.cookie)).map((t) => t.title)).toEqual(['alice note']);
    expect((await listTitles(bob.cookie)).map((t) => t.title)).toEqual(['bob note']);
  });

  it('rejects a duplicate that is still in flight', async () => {
    const { cookie, user } = await registerUser(ctx.app);
    await seed({
      userId: user.id,
      key: KEY,
      fingerprint: requestFingerprint('POST', '/api/todos', { title: 'buy milk' }),
      status: 'in_progress',
      ageSeconds: 5,
      expiresInSeconds: 3600,
    });

    const res = await post(cookie, 'buy milk', KEY);
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('idempotency_in_progress');
    expect(res.headers['retry-after']).toBe('1');
    expect(await listTitles(cookie)).toHaveLength(0);
  });

  it('takes over an abandoned attempt', async () => {
    const { cookie, user } = await registerUser(ctx.app);
    await seed({
      userId: user.id,
      key: KEY,
      fingerprint: requestFingerprint('POST', '/api/todos', { title: 'buy milk' }),
      status: 'in_progress',
      ageSeconds: 120, // older than the 60s lease
      expiresInSeconds: 3600,
    });

    const res = await post(cookie, 'buy milk', KEY);
    expect(res.statusCode).toBe(201);
    expect(await listTitles(cookie)).toHaveLength(1);
    expect((await records(user.id))[0]).toMatchObject({ status: 'completed' });
  });

  it('an expired key is reusable', async () => {
    const { cookie, user } = await registerUser(ctx.app);
    await seed({
      userId: user.id,
      key: KEY,
      fingerprint: requestFingerprint('POST', '/api/todos', { title: 'buy milk' }),
      status: 'completed',
      ageSeconds: 90_000,
      expiresInSeconds: -3600,
      responseBody: { id: '00000000-0000-0000-0000-0000000000ff' },
    });

    const res = await post(cookie, 'buy milk', KEY);
    expect(res.statusCode).toBe(201);
    expect(res.headers['idempotency-replayed']).toBeUndefined();
    expect(res.json<{ id: string }>().id).not.toBe('00000000-0000-0000-0000-0000000000ff');
    expect(await listTitles(cookie)).toHaveLength(1);
  });

  it('no key means no record', async () => {
    const { cookie } = await registerUser(ctx.app);

    const res = await post(cookie, 'buy milk');
    expect(res.statusCode).toBe(201);
    expect(res.headers['idempotency-replayed']).toBeUndefined();
    expect(await listTitles(cookie)).toHaveLength(1);
    expect(await records()).toHaveLength(0);
  });

  it('rejects a malformed key', async () => {
    const { cookie } = await registerUser(ctx.app);

    for (const key of ['x'.repeat(15), 'x'.repeat(256), 'has/a/slash/and/length']) {
      const res = await post(cookie, 'buy milk', key);
      expect(res.statusCode, key.slice(0, 24)).toBe(400);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('validation_failed');
    }

    expect(await listTitles(cookie)).toHaveLength(0);
    expect(await records()).toHaveLength(0);
  });

  it('unauthenticated request with a key', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/todos',
      headers: { 'idempotency-key': KEY },
      payload: { title: 'buy milk' },
    });

    expect(res.statusCode).toBe(401);
    expect(await records()).toHaveLength(0);
  });

  it('a failed request does not consume the key', async () => {
    const { cookie } = await registerUser(ctx.app);

    const bad = await post(cookie, '', KEY);
    expect(bad.statusCode).toBe(400);
    expect(await records()).toHaveLength(0);

    const good = await post(cookie, 'buy milk', KEY);
    expect(good.statusCode).toBe(201);
    expect(good.headers['idempotency-replayed']).toBeUndefined();
    expect(await listTitles(cookie)).toHaveLength(1);

    // A failure *after* the key is claimed must release it too. A NUL byte
    // passes schema validation and is then rejected by Postgres, which is the
    // cheapest way to fail inside the handler.
    const key2 = 'idem-key-0000000002';
    const boom = await post(cookie, 'buy \u0000 milk', key2);
    expect(boom.statusCode).toBe(500);
    expect((await records()).map((r) => r.key)).toEqual([KEY]);

    const retry = await post(cookie, 'buy more milk', key2);
    expect(retry.statusCode).toBe(201);
  });

  it("sweeps this user's expired records", async () => {
    const alice = await registerUser(ctx.app, 'alice@example.com');
    const bob = await registerUser(ctx.app, 'bob@example.com');
    const fingerprint = requestFingerprint('POST', '/api/todos', { title: 'old' });

    for (const key of ['expired-key-000000001', 'expired-key-000000002']) {
      await seed({
        userId: alice.user.id,
        key,
        fingerprint,
        status: 'completed',
        ageSeconds: 90_000,
        expiresInSeconds: -3600,
        responseBody: { id: '00000000-0000-0000-0000-0000000000ff' },
      });
    }
    await seed({
      userId: bob.user.id,
      key: 'expired-key-000000001',
      fingerprint,
      status: 'completed',
      ageSeconds: 90_000,
      expiresInSeconds: -3600,
      responseBody: { id: '00000000-0000-0000-0000-0000000000ff' },
    });

    const res = await post(alice.cookie, 'buy milk', KEY);
    expect(res.statusCode).toBe(201);

    // Only Alice's expired rows are gone, and only her fresh one remains.
    expect((await records(alice.user.id)).map((r) => r.key)).toEqual([KEY]);
    expect((await records(bob.user.id)).map((r) => r.key)).toEqual(['expired-key-000000001']);
  });

  it('sweeps at most a bounded batch per request', async () => {
    const alice = await registerUser(ctx.app, 'alice@example.com');
    const fingerprint = requestFingerprint('POST', '/api/todos', { title: 'old' });

    // 105 expired rows: one bounded sweep must leave exactly the overflow
    // behind rather than deleting an unbounded number inline.
    await ctx.db.execute(sql`
      INSERT INTO idempotency_keys
        (user_id, key, fingerprint, status, response_status, response_body, created_at, expires_at)
      SELECT ${alice.user.id}, 'expired-key-' || lpad(i::text, 9, '0'), ${fingerprint},
             'completed', 201, ${JSON.stringify({ id: 'x' })}::jsonb,
             now() - make_interval(secs => 90000), now() - make_interval(secs => 3600)
        FROM generate_series(1, 105) AS i`);

    const res = await post(alice.cookie, 'buy milk', KEY);
    expect(res.statusCode).toBe(201);

    const remaining = await records(alice.user.id);
    // 105 expired − 100 swept + the row this request just stored.
    expect(remaining).toHaveLength(6);
    expect(remaining.filter((r) => r.key === KEY)).toHaveLength(1);
  });

  it('a failing sweep does not fail the request', async () => {
    const { cookie, user } = await registerUser(ctx.app);
    await seed({
      userId: user.id,
      key: 'expired-key-000000001',
      fingerprint: requestFingerprint('POST', '/api/todos', { title: 'old' }),
      status: 'completed',
      ageSeconds: 90_000,
      expiresInSeconds: -3600,
      responseBody: { id: '00000000-0000-0000-0000-0000000000ff' },
    });

    // Stand in for a query timeout or lock contention on the sweep: the DELETE
    // raises, the create must still succeed.
    await ctx.db.execute(sql`
      CREATE FUNCTION idem_sweep_boom() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'sweep exploded'; END $$`);
    await ctx.db.execute(sql`
      CREATE TRIGGER idem_sweep_boom BEFORE DELETE ON idempotency_keys
      FOR EACH ROW EXECUTE FUNCTION idem_sweep_boom()`);

    try {
      const res = await post(cookie, 'buy milk', KEY);
      expect(res.statusCode).toBe(201);
      expect(await listTitles(cookie)).toHaveLength(1);
      // The key is still claimed and finalised, so a retry replays.
      const replay = await post(cookie, 'buy milk', KEY);
      expect(replay.headers['idempotency-replayed']).toBe('true');
      expect(await listTitles(cookie)).toHaveLength(1);
    } finally {
      await ctx.db.execute(sql`DROP TRIGGER idem_sweep_boom ON idempotency_keys`);
      await ctx.db.execute(sql`DROP FUNCTION idem_sweep_boom()`);
    }
  });

  it('exposes idempotency outcomes', async () => {
    const { cookie, user } = await registerUser(ctx.app);

    await post(cookie, 'buy milk', KEY); // stored
    await post(cookie, 'buy milk', KEY); // replayed
    await post(cookie, 'buy bread', KEY); // conflict
    await seed({
      userId: user.id,
      key: 'takeover-key-00000001',
      fingerprint: requestFingerprint('POST', '/api/todos', { title: 'buy eggs' }),
      status: 'in_progress',
      ageSeconds: 120,
      expiresInSeconds: 3600,
    });
    await post(cookie, 'buy eggs', 'takeover-key-00000001'); // takeover

    const metrics = await ctx.app.inject({ url: '/metrics' });
    expect(metrics.statusCode).toBe(200);
    for (const outcome of ['stored', 'replayed', 'conflict', 'takeover']) {
      expect(metrics.body, outcome).toMatch(
        new RegExp(`idempotency_requests_total\\{[^}]*outcome="${outcome}"[^}]*\\} [1-9]`),
      );
    }
  });
});
