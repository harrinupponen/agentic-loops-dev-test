import { eq, sql } from 'drizzle-orm';
import Redis from 'ioredis';
import { Writable } from 'node:stream';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { todos } from '../../src/db/schema.js';
import {
  createTestContext,
  metricsAuth,
  registerUser,
  resetDb,
  type TestContext,
} from './helpers.js';
import { startTcpProxy } from './tcp-proxy.js';

/** Started by tests/integration/global-setup.ts; never exported as REDIS_URL. */
const REDIS_URL = process.env.TEST_REDIS_URL ?? '';

/** Every context this file builds turns both switches on unless it says otherwise. */
const CACHE_ON = { REDIS_URL, TODO_LIST_CACHE_ENABLED: 'true', AUTH_RATE_LIMIT_MAX: '10000' };

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

/**
 * The proof a hit is a hit: a counter around the pool the app actually uses.
 * Only list queries are counted — session loading and the limiter share it.
 */
function countListQueries(pool: pg.Pool) {
  const original = pool.query.bind(pool) as (...args: unknown[]) => unknown;
  let count = 0;
  (pool as unknown as { query: unknown }).query = (...args: unknown[]) => {
    const first = args[0] as string | { text?: string } | undefined;
    const text = typeof first === 'string' ? first : (first?.text ?? '');
    if (/^\s*select\b[\s\S]*\bfrom "todos"/i.test(text)) count += 1;
    return original(...args);
  };
  return {
    count: () => count,
    reset: () => {
      count = 0;
    },
    restore: () => {
      (pool as unknown as { query: unknown }).query = original;
    },
  };
}

/** app.inject() can beat the socket; the cases about hits wait for it. */
async function connected(ctx: TestContext) {
  for (let i = 0; i < 200 && ctx.app.cacheRedis?.status !== 'ready'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(ctx.app.cacheRedis?.status).toBe('ready');
  return ctx;
}

/** Reads one labelled sample out of a prometheus exposition body. */
function counter(body: string, operation: string, outcome: string): number {
  const line = body
    .split('\n')
    .find(
      (l) =>
        l.startsWith('todo_list_cache_operations_total{') &&
        l.includes(`operation="${operation}"`) &&
        l.includes(`outcome="${outcome}"`),
    );
  return line ? Number(line.slice(line.lastIndexOf(' ') + 1)) : 0;
}

async function cacheCounters(ctx: TestContext) {
  const res = await ctx.app.inject({ url: '/metrics', headers: metricsAuth() });
  return {
    hit: counter(res.body, 'get', 'hit'),
    miss: counter(res.body, 'get', 'miss'),
    setOk: counter(res.body, 'set', 'ok'),
    invalidateOk: counter(res.body, 'invalidate', 'ok'),
    invalidateError: counter(res.body, 'invalidate', 'error'),
    total: ['hit', 'miss', 'invalid', 'error'].reduce(
      (sum, o) => sum + counter(res.body, 'get', o) + counter(res.body, 'set', o),
      0,
    ),
  };
}

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

/** The shared, cache-on context most cases use. */
describe('todo list cache', () => {
  let ctx: TestContext;
  let queries: ReturnType<typeof countListQueries>;

  beforeAll(async () => {
    ctx = await connected(await createTestContext(CACHE_ON));
    queries = countListQueries(ctx.pool);
  });
  afterAll(async () => {
    queries.restore();
    await ctx.close();
  });
  beforeEach(async () => {
    await resetDb(ctx.db);
    await redis.flushall();
    queries.reset();
  });

  const list = (cookie: string, query = '') =>
    ctx.app.inject({ url: `/api/todos${query}`, headers: { cookie } });

  async function createTodo(cookie: string, title: string) {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/todos',
      headers: { cookie },
      payload: { title },
    });
    expect(res.statusCode).toBe(201);
    return res.json<{ id: string; title: string }>();
  }

  async function user(prefix: string) {
    return registerUser(ctx.app, `${prefix}-${Date.now()}-${Math.random()}@example.com`);
  }

  it('a repeated list is served from the cache', async () => {
    const { cookie } = await user('hit');
    await createTodo(cookie, 'milk');
    queries.reset();

    const first = await list(cookie);
    const second = await list(cookie);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.body).toBe(first.body);
    // One list query for two identical requests: the second never reached Postgres.
    expect(queries.count()).toBe(1);
  });

  it('a cache hit matches the database answer exactly', async () => {
    const { cookie } = await user('exact');
    await createTodo(cookie, 'one');
    await createTodo(cookie, 'two');

    const fromDb = await list(cookie, '?limit=1');
    const fromCache = await list(cookie, '?limit=1');

    // Byte for byte, including nextCursor and every date rendering.
    expect(fromCache.body).toBe(fromDb.body);
    expect(fromCache.json()).toEqual(fromDb.json());
    const body = fromCache.json<{ items: unknown[]; nextCursor: string | null }>();
    expect(body.items).toHaveLength(1);
    expect(body.nextCursor).not.toBeNull();
  });

  // ADR 0016 named this bug in advance: a key without the deleted filter serves
  // the trash to the live view.
  it('the trash view and the live list are separate entries', async () => {
    const { cookie } = await user('trash');
    const live = await createTodo(cookie, 'live');
    const gone = await createTodo(cookie, 'gone');
    await ctx.app.inject({ method: 'DELETE', url: `/api/todos/${gone.id}`, headers: { cookie } });

    const trashFirst = await list(cookie, '?deleted=true');
    const liveFirst = await list(cookie);
    const trashSecond = await list(cookie, '?deleted=true');
    const liveSecond = await list(cookie);

    const titles = (res: { json: <T>() => T }) =>
      res.json<{ items: { title: string }[] }>().items.map((i) => i.title);
    expect(titles(trashFirst)).toEqual(['gone']);
    expect(titles(trashSecond)).toEqual(['gone']);
    expect(titles(liveFirst)).toEqual(['live']);
    expect(titles(liveSecond)).toEqual(['live']);
    expect(live.title).toBe('live');
  });

  it('every query dimension is part of the key', async () => {
    const { cookie } = await user('dims');
    const done = await createTodo(cookie, 'done');
    await createTodo(cookie, 'open');
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/todos/${done.id}`,
      headers: { cookie },
      payload: { completed: true },
    });

    const titles = async (query: string) => {
      // Twice: the second answer is the cached one and must match the first.
      const first = await list(cookie, query);
      const second = await list(cookie, query);
      expect(second.body).toBe(first.body);
      return second.json<{ items: { title: string }[] }>().items.map((i) => i.title);
    };

    expect(await titles('')).toEqual(['open', 'done']);
    expect(await titles('?completed=true')).toEqual(['done']);
    expect(await titles('?completed=false')).toEqual(['open']);
    expect(await titles('?limit=1')).toEqual(['open']);
  });

  it('paginated requests bypass the cache', async () => {
    const { cookie } = await user('cursor');
    await createTodo(cookie, 'older');
    await createTodo(cookie, 'newer');

    const page = await list(cookie, '?limit=1');
    const cursor = page.json<{ nextCursor: string }>().nextCursor;
    queries.reset();

    const second = await list(cookie, `?limit=1&cursor=${encodeURIComponent(cursor)}`);
    const third = await list(cookie, `?limit=1&cursor=${encodeURIComponent(cursor)}`);

    expect(second.json<{ items: { title: string }[] }>().items.map((i) => i.title)).toEqual([
      'older',
    ]);
    expect(third.body).toBe(second.body);
    // Never read from and never written to: both requests queried Postgres, and
    // the cursor-less entry written by the first page is the only field stored.
    expect(queries.count()).toBe(2);
    const key = (await redis.keys('c:todos:*'))[0]!;
    expect(await redis.hkeys(key)).toEqual(['v1:live:any:1']);
  });

  it('a create invalidates the caller`s list', async () => {
    const { cookie } = await user('w-create');
    await createTodo(cookie, 'first');
    await list(cookie);

    await createTodo(cookie, 'second');

    expect(await list(cookie).then((r) => r.json<{ items: unknown[] }>().items)).toHaveLength(2);
  });

  it('an update invalidates the caller`s list', async () => {
    const { cookie } = await user('w-update');
    const todo = await createTodo(cookie, 'before');
    await list(cookie);

    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/todos/${todo.id}`,
      headers: { cookie },
      payload: { title: 'after', completed: true },
    });

    const items = (await list(cookie)).json<{ items: { title: string; completed: boolean }[] }>()
      .items;
    expect(items).toEqual([expect.objectContaining({ title: 'after', completed: true })]);
  });

  it('a delete invalidates the caller`s list', async () => {
    const { cookie } = await user('w-delete');
    const todo = await createTodo(cookie, 'doomed');
    await list(cookie);

    await ctx.app.inject({ method: 'DELETE', url: `/api/todos/${todo.id}`, headers: { cookie } });

    expect((await list(cookie)).json<{ items: unknown[] }>().items).toEqual([]);
  });

  it('a restore invalidates the caller`s list', async () => {
    const { cookie } = await user('w-restore');
    const todo = await createTodo(cookie, 'back');
    await ctx.app.inject({ method: 'DELETE', url: `/api/todos/${todo.id}`, headers: { cookie } });
    await list(cookie);

    await ctx.app.inject({
      method: 'POST',
      url: `/api/todos/${todo.id}/restore`,
      headers: { cookie },
    });

    expect((await list(cookie)).json<{ items: unknown[] }>().items).toHaveLength(1);
  });

  // The sweep removes rows from the trash view inside the DELETE handler, so the
  // invalidation that covers the delete has to cover what the sweep took too.
  it('the retention sweep invalidates the caller`s trash view', async () => {
    const { cookie } = await user('w-sweep');
    const expired = await createTodo(cookie, 'expired');
    const other = await createTodo(cookie, 'other');
    await ctx.app.inject({
      method: 'DELETE',
      url: `/api/todos/${expired.id}`,
      headers: { cookie },
    });
    await ctx.db
      .update(todos)
      .set({ deletedAt: sql`now() - interval '31 days'` })
      .where(eq(todos.id, expired.id));

    const before = await list(cookie, '?deleted=true');
    expect(before.json<{ items: { title: string }[] }>().items.map((i) => i.title)).toEqual([
      'expired',
    ]);

    // Deletes `other` and, in the same request, purges `expired`.
    await ctx.app.inject({ method: 'DELETE', url: `/api/todos/${other.id}`, headers: { cookie } });

    expect(
      (await list(cookie, '?deleted=true'))
        .json<{ items: { title: string }[] }>()
        .items.map((i) => i.title),
    ).toEqual(['other']);
  });

  // The hardest case in the feature: a row reappears mid-ordering at its
  // original created_at and both views change at once (ADR 0020).
  it('restore invalidates both views', async () => {
    const { cookie } = await user('both');
    const oldest = await createTodo(cookie, 'oldest');
    await createTodo(cookie, 'middle');
    await createTodo(cookie, 'newest');
    await ctx.app.inject({ method: 'DELETE', url: `/api/todos/${oldest.id}`, headers: { cookie } });

    expect((await list(cookie)).json<{ items: { title: string }[] }>().items).toHaveLength(2);
    expect((await list(cookie, '?deleted=true')).json<{ items: unknown[] }>().items).toHaveLength(
      1,
    );

    await ctx.app.inject({
      method: 'POST',
      url: `/api/todos/${oldest.id}/restore`,
      headers: { cookie },
    });

    // Back at its original position — last, not first — with no second write.
    expect(
      (await list(cookie)).json<{ items: { title: string }[] }>().items.map((i) => i.title),
    ).toEqual(['newest', 'middle', 'oldest']);
    expect((await list(cookie, '?deleted=true')).json<{ items: unknown[] }>().items).toEqual([]);
  });

  it("another user's failed write against my todo does not invalidate my cache", async () => {
    const owner = await user('owner');
    const stranger = await user('stranger');
    const todo = await createTodo(owner.cookie, 'mine');
    await list(owner.cookie);
    queries.reset();

    const failed = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/todos/${todo.id}`,
      headers: { cookie: stranger.cookie },
      payload: { title: 'yours' },
    });
    expect(failed.statusCode).toBe(404);

    // Still a hit: a write that changed nothing discards nothing.
    const after = await list(owner.cookie);
    expect(after.json<{ items: { title: string }[] }>().items.map((i) => i.title)).toEqual([
      'mine',
    ]);
    expect(queries.count()).toBe(0);
  });

  it("the caller's own failed write does not invalidate", async () => {
    const owner = await user('own-fail');
    await createTodo(owner.cookie, 'mine');
    await list(owner.cookie);
    queries.reset();

    const missing = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/todos/33333333-3333-4333-8333-333333333333',
      headers: { cookie: owner.cookie },
      payload: { title: 'nope' },
    });
    expect(missing.statusCode).toBe(404);

    expect((await list(owner.cookie)).statusCode).toBe(200);
    expect(queries.count()).toBe(0); // still a hit: a write that changed nothing discards nothing
  });

  it('invalidation is scoped to one user', async () => {
    const a = await user('scope-a');
    const b = await user('scope-b');
    await createTodo(a.cookie, 'a-one');
    await createTodo(b.cookie, 'b-one');
    await list(a.cookie);
    await list(b.cookie);
    queries.reset();

    await createTodo(b.cookie, 'b-two');

    // A is untouched by B's write, and neither ever sees the other's page.
    const aAfter = await list(a.cookie);
    expect(queries.count()).toBe(0);
    expect(aAfter.json<{ items: { title: string }[] }>().items.map((i) => i.title)).toEqual([
      'a-one',
    ]);
    const bAfter = await list(b.cookie);
    expect(bAfter.json<{ items: { title: string }[] }>().items.map((i) => i.title)).toEqual([
      'b-two',
      'b-one',
    ]);
    expect(await redis.keys('c:todos:*')).toHaveLength(2);
  });

  it('cache keys carry no raw identity', async () => {
    const one = await user('key-one');
    const two = await user('key-two');
    await createTodo(one.cookie, 'secret title');
    await list(one.cookie);
    await list(two.cookie);

    const keys = await redis.keys('c:*');
    expect(keys).toHaveLength(2);
    for (const key of keys) {
      expect(key).toMatch(/^c:todos:[0-9a-f]{32}$/);
      expect(key).not.toContain(one.user.id);
      expect(key).not.toContain(two.user.id);
    }
  });

  it('a validation failure touches the cache on neither path', async () => {
    const { cookie } = await user('invalid');
    const res = await list(cookie, '?limit=0');

    expect(res.statusCode).toBe(400);
    expect(await redis.keys('c:*')).toEqual([]);
  });

  it('an unauthenticated request creates no entry', async () => {
    const res = await ctx.app.inject({ url: '/api/todos' });

    expect(res.statusCode).toBe(401);
    expect(await redis.keys('c:*')).toEqual([]);
  });

  it('the hash is bounded', async () => {
    const { cookie } = await user('bounded');
    await createTodo(cookie, 'one');

    for (let limit = 1; limit <= 20; limit++) await list(cookie, `?limit=${limit}`);

    const key = (await redis.keys('c:todos:*'))[0]!;
    expect(await redis.hlen(key)).toBeLessThanOrEqual(16);
    // Whatever survived is still a servable entry, not a truncated one.
    for (const value of Object.values(await redis.hgetall(key))) {
      expect(() => JSON.parse(value) as unknown).not.toThrow();
    }
  });

  it('the cache counter reflects what happened', async () => {
    const { cookie } = await user('counter');
    await createTodo(cookie, 'counted');
    const before = await cacheCounters(ctx);

    await list(cookie);
    const afterMiss = await cacheCounters(ctx);
    await list(cookie);
    const afterHit = await cacheCounters(ctx);
    await createTodo(cookie, 'again');
    const afterWrite = await cacheCounters(ctx);

    expect(afterMiss.miss).toBe(before.miss + 1);
    expect(afterMiss.setOk).toBe(before.setOk + 1);
    expect(afterHit.hit).toBe(before.hit + 1);
    expect(afterWrite.invalidateOk).toBeGreaterThan(before.invalidateOk);
    expect(afterWrite.invalidateError).toBe(before.invalidateError);
  });
});

describe('todo list cache expiry', () => {
  it('entries expire', async () => {
    const ctx = await connected(
      await createTestContext({ ...CACHE_ON, TODO_LIST_CACHE_TTL_SECONDS: '1' }),
    );
    try {
      await resetDb(ctx.db);
      await redis.flushall();
      const { cookie } = await registerUser(ctx.app, `ttl-${Date.now()}@example.com`);
      await ctx.app.inject({ url: '/api/todos', headers: { cookie } });

      const key = (await redis.keys('c:todos:*'))[0]!;
      const ttl = await redis.pttl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(1000);
    } finally {
      await ctx.close();
    }
  });
});

describe('todo list cache when disabled', () => {
  it('no cache client is built when the cache is disabled', async () => {
    const logs = captureLogs();
    // REDIS_URL is set, so the limiter has a client: the only thing off is the
    // cache, and it must issue no command at all.
    const ctx = await createTestContext(
      { REDIS_URL, AUTH_RATE_LIMIT_MAX: '10000', LOG_LEVEL: 'info' },
      { logStream: logs.stream },
    );
    const queries = countListQueries(ctx.pool);
    try {
      expect(ctx.app.cacheRedis).toBeNull();
      // A delta, because the counter is a module singleton shared by every app
      // this process builds: what matters is that THIS context moves it by zero.
      const before = (await cacheCounters(ctx)).total;
      const { cookie } = await registerUser(ctx.app, `off-${Date.now()}@example.com`);
      await ctx.app.inject({
        method: 'POST',
        url: '/api/todos',
        headers: { cookie },
        payload: { title: 'uncached' },
      });
      queries.reset();

      const first = await ctx.app.inject({ url: '/api/todos', headers: { cookie } });
      const second = await ctx.app.inject({ url: '/api/todos', headers: { cookie } });

      expect(second.body).toBe(first.body);
      // Every request went to Postgres, exactly as it did before F-012.
      expect(queries.count()).toBe(2);
      expect(await redis.keys('c:*')).toEqual([]);
      expect((await cacheCounters(ctx)).total).toBe(before);
      expect(logs.text()).toContain('"todoListCache":"off"');
    } finally {
      queries.restore();
      await ctx.close();
    }
  });

  it('boot reports the cache', async () => {
    const logs = captureLogs();
    const ctx = await createTestContext(
      { ...CACHE_ON, LOG_LEVEL: 'info' },
      { logStream: logs.stream },
    );
    try {
      expect(logs.text()).toContain('"todoListCache":"redis"');
      expect(logs.text()).toContain('"ttlSeconds":30');
    } finally {
      await ctx.close();
    }
  });

  it('the cache client is closed with the app', async () => {
    const ctx = await connected(await createTestContext(CACHE_ON));
    const { cookie } = await registerUser(ctx.app, `close-${Date.now()}@example.com`);
    await ctx.app.inject({ url: '/api/todos', headers: { cookie } });

    await ctx.close();

    await expect(ctx.app.cacheRedis?.ping()).rejects.toThrow();
    await expect.poll(() => ctx.app.cacheRedis?.status, { timeout: 5_000 }).toBe('end');
  });
});

// ADR 0021: the request produces exactly the response it would have produced
// with the cache switched off.
describe('todo list cache during an outage', () => {
  let proxy: Awaited<ReturnType<typeof startTcpProxy>>;
  let ctx: TestContext;
  let logs: ReturnType<typeof captureLogs>;

  beforeEach(async () => {
    proxy = await startTcpProxy(REDIS_URL);
    logs = captureLogs();
    ctx = await connected(
      await createTestContext(
        { ...CACHE_ON, REDIS_URL: proxy.url, LOG_LEVEL: 'info' },
        { logStream: logs.stream },
      ),
    );
    await resetDb(ctx.db);
  });
  afterEach(async () => {
    await ctx.close();
    await proxy.close();
  });

  it('an unreachable cache is a miss, not an error', async () => {
    const { cookie } = await registerUser(ctx.app, `out-${Date.now()}@example.com`);
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/todos',
      headers: { cookie },
      payload: { title: 'survives' },
    });
    expect(created.statusCode).toBe(201);
    const healthy = await ctx.app.inject({ url: '/api/todos', headers: { cookie } });

    proxy.fail();

    const responses = [
      await ctx.app.inject({ url: '/api/todos', headers: { cookie } }),
      await ctx.app.inject({ url: '/api/todos', headers: { cookie } }),
      await ctx.app.inject({
        method: 'POST',
        url: '/api/todos',
        headers: { cookie },
        payload: { title: 'written during the outage' },
      }),
      await ctx.app.inject({ url: '/api/todos', headers: { cookie } }),
    ];

    // Correct data from Postgres throughout, and no 5xx anywhere.
    expect(responses.some((r) => r.statusCode >= 500)).toBe(false);
    expect(responses[0]!.statusCode).toBe(200);
    expect(responses[0]!.body).toBe(healthy.body);
    expect(responses[2]!.statusCode).toBe(201);
    expect(responses[3]!.json<{ items: unknown[] }>().items).toHaveLength(2);
    // One warn for the whole outage, not one per request.
    expect(logs.text().split('todo list cache degraded').length - 1).toBe(1);

    proxy.restore();
    await expect
      .poll(
        async () => {
          await ctx.app.inject({ url: '/api/todos', headers: { cookie } });
          return logs.text();
        },
        { timeout: 20_000, interval: 250 },
      )
      .toContain('todo list cache recovered');
  });

  it('a timing-out cache does not stall the request', async () => {
    const { cookie } = await registerUser(ctx.app, `slow-${Date.now()}@example.com`);
    await ctx.app.inject({ url: '/api/todos', headers: { cookie } }); // warm the route
    proxy.fail();

    const started = Date.now();
    const res = await ctx.app.inject({ url: '/api/todos', headers: { cookie } });
    const elapsed = Date.now() - started;

    expect(res.statusCode).toBe(200);
    expect(elapsed).toBeLessThan(50 + 50);
  });

  it('the cache logs no content and no url', async () => {
    const { cookie } = await registerUser(ctx.app, `quiet-${Date.now()}@example.com`);
    await ctx.app.inject({
      method: 'POST',
      url: '/api/todos',
      headers: { cookie },
      payload: { title: 'a-very-distinctive-title' },
    });
    proxy.fail();
    await ctx.app.inject({ url: '/api/todos', headers: { cookie } });

    expect(logs.text()).toContain('todo list cache degraded');
    expect(logs.text()).not.toContain('a-very-distinctive-title');
    expect(logs.text()).not.toContain('redis://');
  });
});
