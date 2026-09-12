import Redis from 'ioredis';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, metricsAuth, registerUser, type TestContext } from './helpers.js';
import { startTcpProxy } from './tcp-proxy.js';

/** Started by tests/integration/global-setup.ts; never exported as REDIS_URL. */
const REDIS_URL = process.env.TEST_REDIS_URL ?? '';

/** The 429 envelope, asserted identically against both stores. */
const RATE_LIMITED = {
  error: {
    code: 'rate_limited',
    message: expect.stringMatching(/^Too many requests\. Retry in /) as unknown as string,
  },
  requestId: expect.any(String) as unknown as string,
};

function captureLogs() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });
  return { lines, stream, text: () => lines.join('') };
}

/** Reads one labelled sample out of a prometheus exposition body. */
function counter(body: string, store: string, outcome: string): number {
  const line = body
    .split('\n')
    .find(
      (l) =>
        l.startsWith(`rate_limit_store_operations_total{`) &&
        l.includes(`store="${store}"`) &&
        l.includes(`outcome="${outcome}"`),
    );
  return line ? Number(line.slice(line.lastIndexOf(' ') + 1)) : 0;
}

/**
 * Real traffic arrives after the connection is up; `app.inject()` can arrive
 * before it, so the cases about shared counting wait for the socket first.
 */
async function connected(ctx: TestContext) {
  for (let i = 0; i < 200 && ctx.app.redis?.status !== 'ready'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(ctx.app.redis?.status).toBe('ready');
  return ctx;
}

async function storeCounters(ctx: TestContext) {
  const res = await ctx.app.inject({ url: '/metrics', headers: metricsAuth() });
  return {
    redisOk: counter(res.body, 'redis', 'ok'),
    redisError: counter(res.body, 'redis', 'error'),
    localOk: counter(res.body, 'local', 'ok'),
  };
}

describe('rate limiting', () => {
  it('returns 429 with a well-formed body once the limit is exceeded', async () => {
    const ctx = await createTestContext({ RATE_LIMIT_MAX: '1', RATE_LIMIT_WINDOW: '1 minute' });
    try {
      const first = await ctx.app.inject({ url: '/api/todos' });
      expect(first.statusCode).toBe(401); // under the limit, reaches auth as normal

      const second = await ctx.app.inject({ url: '/api/todos' });
      expect(second.statusCode).toBe(429);
      expect(second.json<{ error: { code: string } }>().error.code).toBe('rate_limited');
    } finally {
      await ctx.close();
    }
  });

  it('no redis client is built when REDIS_URL is empty', async () => {
    const logs = captureLogs();
    const ctx = await createTestContext(
      { RATE_LIMIT_MAX: '1', LOG_LEVEL: 'info' },
      { logStream: logs.stream },
    );
    try {
      expect(ctx.app.redis).toBeNull();

      await ctx.app.inject({ url: '/api/todos' });
      const limited = await ctx.app.inject({ url: '/api/todos' });
      expect(limited.statusCode).toBe(429);

      // The custom store is not in the path at all: nothing it counts moves.
      const counters = await storeCounters(ctx);
      expect(counters.redisOk + counters.redisError + counters.localOk).toBe(0);
      expect(logs.text()).toContain('"rateLimitStore":"memory"');
    } finally {
      await ctx.close();
    }
  });
});

describe('rate limiting backed by redis', () => {
  let redis: Redis;

  beforeAll(() => {
    expect(REDIS_URL, 'global-setup must publish TEST_REDIS_URL').toBeTruthy();
    redis = new Redis(REDIS_URL);
  });
  afterAll(async () => {
    await redis.quit();
  });
  beforeEach(async () => {
    await redis.flushall();
  });

  it('the limit is shared across instances', async () => {
    const overrides = { REDIS_URL, RATE_LIMIT_MAX: '2' };
    const a = await connected(await createTestContext(overrides));
    const b = await connected(await createTestContext(overrides));
    try {
      expect((await a.app.inject({ url: '/api/todos' })).statusCode).toBe(401);
      expect((await b.app.inject({ url: '/api/todos' })).statusCode).toBe(401);
      // Third request against the shared budget, whichever instance serves it.
      expect((await a.app.inject({ url: '/api/todos' })).statusCode).toBe(429);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('the redis-backed 429 envelope is unchanged', async () => {
    const local = await createTestContext({ RATE_LIMIT_MAX: '1' });
    const shared = await connected(await createTestContext({ REDIS_URL, RATE_LIMIT_MAX: '1' }));
    try {
      for (const ctx of [local, shared]) await ctx.app.inject({ url: '/api/todos' });
      const localBody = (await local.app.inject({ url: '/api/todos' })).json<unknown>();
      const sharedRes = await shared.app.inject({ url: '/api/todos' });

      expect(localBody).toEqual(RATE_LIMITED);
      expect(sharedRes.json()).toEqual(RATE_LIMITED);
      expect(sharedRes.statusCode).toBe(429);
      expect(sharedRes.headers['x-ratelimit-limit']).toBe('1');
    } finally {
      await local.close();
      await shared.close();
    }
  });

  it('per-route limits keep separate keys', async () => {
    const ctx = await connected(await createTestContext({ REDIS_URL, AUTH_RATE_LIMIT_MAX: '1' }));
    try {
      const login = { email: 'nobody@example.com', password: 'correct-horse-battery-staple' };
      expect(
        (await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: login }))
          .statusCode,
      ).toBe(401);
      expect(
        (await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: login }))
          .statusCode,
      ).toBe(429);
      // The global bucket is untouched by the exhausted auth bucket.
      expect((await ctx.app.inject({ url: '/api/todos' })).statusCode).toBe(401);
    } finally {
      await ctx.close();
    }
  });

  it('redis keys carry no raw identity', async () => {
    const ctx = await connected(await createTestContext({ REDIS_URL }));
    try {
      const one = await registerUser(ctx.app, `rl-one-${Date.now()}@example.com`);
      const two = await registerUser(ctx.app, `rl-two-${Date.now()}@example.com`);
      await ctx.app.inject({ url: '/api/todos', headers: { cookie: one.cookie } });
      await ctx.app.inject({ url: '/api/todos', headers: { cookie: two.cookie } });

      const keys = await redis.keys('*');
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        expect(key).toMatch(/^rl:[\w/:.-]*[0-9a-f]{32}$/);
        expect(key).not.toContain('127.0.0.1');
        expect(key).not.toContain(one.user.id);
        expect(key).not.toContain(two.user.id);
      }
      // Two users, two distinct buckets: nobody inherits anybody's budget.
      const todoKeys = keys.filter((k) => /^rl:[0-9a-f]{32}$/.test(k));
      expect(todoKeys).toHaveLength(2);
      // Registration ran under the tighter per-route bucket, keyed by IP.
      expect(keys.some((k) => k.startsWith('rl:POST/api/auth/register-'))).toBe(true);
    } finally {
      await ctx.close();
    }
  });

  it('a redis outage degrades to a local limit rather than failing', async () => {
    const proxy = await startTcpProxy(REDIS_URL);
    const logs = captureLogs();
    const ctx = await connected(
      await createTestContext(
        { REDIS_URL: proxy.url, RATE_LIMIT_MAX: '1', LOG_LEVEL: 'info' },
        { logStream: logs.stream },
      ),
    );
    try {
      expect((await ctx.app.inject({ url: '/api/todos' })).statusCode).toBe(401);

      proxy.fail();
      // Still limited, just per instance: the local window starts fresh.
      const first = await ctx.app.inject({ url: '/api/todos' });
      const second = await ctx.app.inject({ url: '/api/todos' });
      const third = await ctx.app.inject({ url: '/api/todos' });

      expect(first.statusCode).toBe(401);
      expect(second.statusCode).toBe(429);
      expect(third.statusCode).toBe(429);
      expect([first, second, third].some((r) => r.statusCode >= 500)).toBe(false);
      // One warn for the whole outage, not one per request.
      expect(logs.text().split('rate limiter degraded').length - 1).toBe(1);

      proxy.restore();
      await expect
        .poll(
          async () => {
            await ctx.app.inject({ url: '/api/todos' });
            return logs.text();
          },
          { timeout: 20_000, interval: 250 },
        )
        .toContain('rate limiter recovered');
    } finally {
      await ctx.close();
      await proxy.close();
    }
  });

  it('a timing-out store does not stall the request', async () => {
    const proxy = await startTcpProxy(REDIS_URL);
    const ctx = await connected(
      await createTestContext({ REDIS_URL: proxy.url, REDIS_TIMEOUT_MS: '50' }),
    );
    try {
      await ctx.app.inject({ url: '/api/todos' }); // warm the route
      proxy.fail();

      const started = Date.now();
      const res = await ctx.app.inject({ url: '/api/todos' });
      const elapsed = Date.now() - started;

      expect(res.statusCode).toBe(401);
      expect(elapsed).toBeLessThan(50 + 50);
    } finally {
      await ctx.close();
      await proxy.close();
    }
  });

  it('the store counter reflects redis health', async () => {
    const proxy = await startTcpProxy(REDIS_URL);
    const ctx = await connected(await createTestContext({ REDIS_URL: proxy.url }));
    try {
      const before = await storeCounters(ctx);
      await ctx.app.inject({ url: '/api/todos' });
      const healthy = await storeCounters(ctx);
      expect(healthy.redisOk).toBeGreaterThan(before.redisOk);

      proxy.fail();
      await ctx.app.inject({ url: '/api/todos' });
      const degraded = await storeCounters(ctx);
      expect(degraded.redisError).toBeGreaterThan(healthy.redisError);
      expect(degraded.localOk).toBeGreaterThan(healthy.localOk);
    } finally {
      await ctx.close();
      await proxy.close();
    }
  });

  it('the redis url is never logged', async () => {
    const logs = captureLogs();
    const ctx = await createTestContext(
      // Unreachable on purpose: this exercises the connection-error path too.
      { REDIS_URL: 'redis://:not-a-real-password@127.0.0.1:1', LOG_LEVEL: 'debug' },
      { logStream: logs.stream },
    );
    try {
      await ctx.app.inject({ url: '/api/todos' });
      expect(logs.text()).toContain('"host":"127.0.0.1"');
      expect(logs.text()).not.toContain('not-a-real-password');
      expect(logs.text()).not.toContain('redis://');
    } finally {
      await ctx.close();
    }
  });

  it('boot reports the store', async () => {
    const logs = captureLogs();
    const ctx = await createTestContext(
      { REDIS_URL, LOG_LEVEL: 'info' },
      { logStream: logs.stream },
    );
    try {
      expect(logs.text()).toContain('"rateLimitStore":"redis"');
      expect(logs.text()).toContain('rate limiter ready');
    } finally {
      await ctx.close();
    }
  });

  it('the client is closed with the app', async () => {
    const ctx = await connected(await createTestContext({ REDIS_URL }));
    await ctx.app.inject({ url: '/api/todos' });
    expect(ctx.app.redis?.status).toBe('ready');

    await ctx.close();
    // Unusable, not merely idle: nothing keeps a socket open past app.close().
    await expect(ctx.app.redis?.ping()).rejects.toThrow();
    await expect.poll(() => ctx.app.redis?.status, { timeout: 5_000 }).toBe('end');
  });
});
