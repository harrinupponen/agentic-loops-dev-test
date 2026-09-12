import type Redis from 'ioredis';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../src/config.js';
import {
  cacheField,
  cacheKey,
  createTodoListCache,
  todoListCacheOperations,
} from '../../src/lib/todo-list-cache.js';

type CacheConfig = Pick<
  Config,
  'REDIS_URL' | 'REDIS_TIMEOUT_MS' | 'COOKIE_SECRET' | 'TODO_LIST_CACHE_TTL_SECONDS'
>;

const config: CacheConfig = {
  REDIS_URL: 'redis://:not-a-real-password@redis.internal:6379',
  REDIS_TIMEOUT_MS: 50,
  COOKIE_SECRET: 's'.repeat(32),
  TODO_LIST_CACHE_TTL_SECONDS: 30,
};

const USER = '11111111-1111-4111-8111-111111111111';
const VARIANT = { deleted: false, limit: 20 };

const BODY = {
  items: [
    {
      id: '22222222-2222-4222-8222-222222222222',
      title: 'milk',
      completed: false,
      createdAt: new Date('2026-09-12T10:00:00.000Z'),
      updatedAt: new Date('2026-09-12T10:00:00.000Z'),
      deletedAt: null,
    },
  ],
  nextCursor: null,
};

/** Minimal stand-in for the ioredis client: hget, del, and the write-back script. */
function fakeRedis(handlers: {
  hget?: (...args: unknown[]) => Promise<string | null>;
  del?: (...args: unknown[]) => Promise<number>;
  set?: (...args: unknown[]) => Promise<unknown>;
}) {
  const calls: { command: string; args: unknown[] }[] = [];
  const record =
    (command: string, handler?: (...args: unknown[]) => Promise<unknown>) =>
    (...args: unknown[]) => {
      calls.push({ command, args });
      return (handler ?? (() => Promise.resolve(null)))(...args);
    };
  const client = {
    defineCommand: vi.fn(),
    hget: record('hget', handlers.hget),
    del: record('del', handlers.del ?? (() => Promise.resolve(1))),
    todoListCacheSet: record('set', handlers.set ?? (() => Promise.resolve('OK'))),
  };
  return { client: client as unknown as Redis, calls };
}

const rejects = () => Promise.reject(new Error('Connection is closed.'));
const hangs = () => new Promise<never>(() => {});

function logSpy() {
  return { warn: vi.fn(), info: vi.fn() };
}

async function counters() {
  return (await todoListCacheOperations.get()).values.map((v) => ({ ...v.labels, value: v.value }));
}

describe('todo list cache field names', () => {
  it('carries the format tag and every query dimension', () => {
    expect(cacheField({ deleted: false, limit: 20 })).toBe('v1:live:any:20');
    expect(cacheField({ deleted: true, limit: 20 })).toBe('v1:trash:any:20');
    expect(cacheField({ deleted: false, completed: true, limit: 20 })).toBe('v1:live:done:20');
    expect(cacheField({ deleted: false, completed: false, limit: 20 })).toBe('v1:live:open:20');
    expect(cacheField({ deleted: false, limit: 21 })).toBe('v1:live:any:21');
  });

  it('gives every combination of dimensions its own field', () => {
    const fields = new Set<string>();
    for (const deleted of [true, false]) {
      for (const completed of [true, false, undefined]) {
        for (const limit of [1, 20, 100]) fields.add(cacheField({ deleted, completed, limit }));
      }
    }
    expect(fields.size).toBe(2 * 3 * 3);
  });
});

describe('todo list cache keys', () => {
  it('is stable, keyed, and contains no raw user id', () => {
    const key = cacheKey(config.COOKIE_SECRET, USER);
    expect(key).toBe(cacheKey(config.COOKIE_SECRET, USER));
    expect(key).toMatch(/^todos:[0-9a-f]{32}$/);
    expect(key).not.toContain(USER);
  });

  it('differs per user and per COOKIE_SECRET', () => {
    const other = '33333333-3333-4333-8333-333333333333';
    expect(cacheKey(config.COOKIE_SECRET, USER)).not.toBe(cacheKey(config.COOKIE_SECRET, other));
    expect(cacheKey(config.COOKIE_SECRET, USER)).not.toBe(cacheKey('d'.repeat(32), USER));
  });
});

describe('todo list cache', () => {
  beforeEach(() => {
    todoListCacheOperations.reset();
  });

  it('returns a stored entry and counts a hit', async () => {
    const stored = JSON.stringify(BODY);
    const { client, calls } = fakeRedis({ hget: () => Promise.resolve(stored) });
    const cache = createTodoListCache(client, config, logSpy());

    await expect(cache.get(USER, VARIANT)).resolves.toEqual(BODY);
    expect(calls[0]!.args).toEqual([cacheKey(config.COOKIE_SECRET, USER), 'v1:live:any:20']);
    expect(await counters()).toEqual(
      expect.arrayContaining([{ operation: 'get', outcome: 'hit', value: 1 }]),
    );
  });

  it('counts a nil answer as a miss', async () => {
    const { client } = fakeRedis({ hget: () => Promise.resolve(null) });
    const cache = createTodoListCache(client, config, logSpy());

    await expect(cache.get(USER, VARIANT)).resolves.toBeUndefined();
    expect(await counters()).toEqual(
      expect.arrayContaining([{ operation: 'get', outcome: 'miss', value: 1 }]),
    );
  });

  // ADR 0021: an unreachable cache is a miss, never an error the caller sees.
  it('a rejecting client makes every operation resolve rather than throw', async () => {
    const { client } = fakeRedis({ hget: rejects, del: rejects, set: rejects });
    const cache = createTodoListCache(client, config, logSpy());

    await expect(cache.get(USER, VARIANT)).resolves.toBeUndefined();
    await expect(cache.set(USER, VARIANT, BODY)).resolves.toBeUndefined();
    await expect(cache.invalidate(USER)).resolves.toBeUndefined();
    expect(await counters()).toEqual(
      expect.arrayContaining([
        { operation: 'get', outcome: 'error', value: 1 },
        { operation: 'set', outcome: 'error', value: 1 },
        { operation: 'invalidate', outcome: 'error', value: 1 },
      ]),
    );
  });

  it('abandons a hung command at REDIS_TIMEOUT_MS', async () => {
    const { client } = fakeRedis({ hget: hangs, del: hangs, set: hangs });
    const cache = createTodoListCache(client, config, logSpy());

    const started = Date.now();
    await expect(cache.get(USER, VARIANT)).resolves.toBeUndefined();
    await expect(cache.invalidate(USER)).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(config.REDIS_TIMEOUT_MS * 2 + 200);
  });

  it('treats a malformed entry as a miss, counted invalid', async () => {
    const notJson = fakeRedis({ hget: () => Promise.resolve('{not json') });
    const wrongShape = fakeRedis({
      hget: () => Promise.resolve(JSON.stringify({ items: [{ id: 'not-a-uuid' }] })),
    });

    for (const fake of [notJson, wrongShape]) {
      const cache = createTodoListCache(fake.client, config, logSpy());
      await expect(cache.get(USER, VARIANT)).resolves.toBeUndefined();
    }
    expect(await counters()).toEqual(
      expect.arrayContaining([{ operation: 'get', outcome: 'invalid', value: 2 }]),
    );
    // An entry that does not parse is discarded, never served and never an error.
    expect(await counters()).not.toContainEqual({ operation: 'get', outcome: 'error', value: 2 });
  });

  it('writes back under a bounded hash with the configured ttl', async () => {
    const { client, calls } = fakeRedis({});
    const cache = createTodoListCache(client, config, logSpy());

    await cache.set(USER, { deleted: true, completed: false, limit: 5 }, BODY);

    const [key, field, value, maxFields, ttlMs] = calls[0]!.args as [
      string,
      string,
      string,
      number,
      number,
    ];
    expect(key).toBe(cacheKey(config.COOKIE_SECRET, USER));
    expect(field).toBe('v1:trash:open:5');
    expect(JSON.parse(value)).toEqual(JSON.parse(JSON.stringify(BODY)));
    expect(maxFields).toBe(16);
    expect(ttlMs).toBe(30_000);
    expect(await counters()).toEqual(
      expect.arrayContaining([{ operation: 'set', outcome: 'ok', value: 1 }]),
    );
  });

  it('stores only what the response schema describes', async () => {
    const { client, calls } = fakeRedis({});
    const cache = createTodoListCache(client, config, logSpy());

    // The handler returns whole rows; user_id must not reach Redis with them.
    await cache.set(USER, VARIANT, {
      ...BODY,
      items: [{ ...BODY.items[0]!, userId: USER } as (typeof BODY)['items'][number]],
    });

    expect(calls[0]!.args[2]).not.toContain(USER);
  });

  it('deletes the whole key on invalidate', async () => {
    const { client, calls } = fakeRedis({});
    const cache = createTodoListCache(client, config, logSpy());

    await cache.invalidate(USER);

    expect(calls[0]!.command).toBe('del');
    expect(calls[0]!.args).toEqual([cacheKey(config.COOKIE_SECRET, USER)]);
    expect(await counters()).toEqual(
      expect.arrayContaining([{ operation: 'invalidate', outcome: 'ok', value: 1 }]),
    );
  });

  // ADR 0021: a store outage must not produce the log flood that hides it.
  it('logs degrade and recover exactly once per transition', async () => {
    let healthy = false;
    const { client } = fakeRedis({
      hget: () => (healthy ? Promise.resolve(null) : rejects()),
      del: () => (healthy ? Promise.resolve(1) : rejects()),
    });
    const log = logSpy();
    const cache = createTodoListCache(client, config, log);

    for (let i = 0; i < 5; i++) await cache.get(USER, VARIANT);
    await cache.invalidate(USER);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();

    healthy = true;
    for (let i = 0; i < 5; i++) await cache.get(USER, VARIANT);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('logs the host and port but never the url or any content', async () => {
    const { client } = fakeRedis({ hget: rejects });
    const log = logSpy();
    const cache = createTodoListCache(client, config, log);

    await cache.get(USER, VARIANT);

    expect(log.warn.mock.calls[0]![0]).toMatchObject({ host: 'redis.internal', port: 6379 });
    const line = JSON.stringify(log.warn.mock.calls[0]);
    expect(line).not.toContain('not-a-real-password');
    expect(line).not.toContain('redis://');
    expect(line).not.toContain(USER);
  });
});
