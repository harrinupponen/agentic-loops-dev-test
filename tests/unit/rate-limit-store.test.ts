import type Redis from 'ioredis';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../src/config.js';
import {
  createRateLimitStore,
  hashIdentity,
  rateLimitStoreOperations,
} from '../../src/lib/rate-limit-store.js';

type StoreConfig = Pick<Config, 'REDIS_URL' | 'REDIS_TIMEOUT_MS' | 'COOKIE_SECRET'>;

const config: StoreConfig = {
  REDIS_URL: 'redis://:not-a-real-password@redis.internal:6379',
  REDIS_TIMEOUT_MS: 50,
  COOKIE_SECRET: 's'.repeat(32),
};

/** Minimal stand-in for the ioredis client: one custom command, recorded. */
function fakeRedis(rateLimit: (...args: unknown[]) => Promise<[number, number]>) {
  const calls: unknown[][] = [];
  const client = {
    defineCommand: vi.fn(),
    rateLimit: (...args: unknown[]) => {
      calls.push(args);
      return rateLimit(...args);
    },
  };
  return { client: client as unknown as Redis, calls };
}

const ok =
  (current: number, ttl = 60_000) =>
  () =>
    Promise.resolve<[number, number]>([current, ttl]);
const rejects = () => Promise.reject(new Error('Connection is closed.'));
const hangs = () => new Promise<[number, number]>(() => {});

function logSpy() {
  return { warn: vi.fn(), info: vi.fn() };
}

/** Promisified `incr`, which the plugin drives with a node-style callback. */
function incr(
  store: {
    incr: (
      k: string,
      cb: (e: Error | null, r?: { current: number; ttl: number }) => void,
      w: number,
      m: number,
    ) => void;
  },
  key: string,
  timeWindow = 60_000,
  max = 10,
) {
  return new Promise<{ current: number; ttl: number }>((resolve, reject) => {
    store.incr(key, (err, res) => (err ? reject(err) : resolve(res!)), timeWindow, max);
  });
}

describe('rate limit store', () => {
  beforeEach(() => {
    rateLimitStoreOperations.reset();
  });

  it('hashes the identity so no raw address or user id reaches redis', async () => {
    const { client, calls } = fakeRedis(ok(1));
    const Store = createRateLimitStore(client, config, logSpy());
    await incr(new Store({}), '203.0.113.7');

    const key = calls[0]![0] as string;
    expect(key).not.toContain('203.0.113.7');
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(key).toBe(hashIdentity(config.COOKIE_SECRET, '203.0.113.7'));
  });

  it('keys the hash with COOKIE_SECRET, so two secrets never collide', () => {
    const a = hashIdentity('a'.repeat(32), '203.0.113.7');
    const b = hashIdentity('b'.repeat(32), '203.0.113.7');
    expect(a).toBe(hashIdentity('a'.repeat(32), '203.0.113.7')); // stable across processes
    expect(a).not.toBe(b);
    expect(hashIdentity('a'.repeat(32), '203.0.113.8')).not.toBe(a);
  });

  it('namespaces a child store by method and route', async () => {
    const { client, calls } = fakeRedis(ok(1));
    const Store = createRateLimitStore(client, config, logSpy());
    const child = new Store({}).child({
      continueExceeding: false,
      exponentialBackoff: false,
      routeInfo: { method: 'POST', url: '/api/auth/login' },
    });
    await incr(child, '203.0.113.7');

    expect(calls[0]![0]).toBe(
      `POST/api/auth/login-${hashIdentity(config.COOKIE_SECRET, '203.0.113.7')}`,
    );
  });

  it('falls back to a local window when redis rejects, rather than erroring', async () => {
    const { client } = fakeRedis(rejects);
    const Store = createRateLimitStore(client, config, logSpy());
    const store = new Store({});

    expect(await incr(store, 'ip')).toMatchObject({ current: 1 });
    expect(await incr(store, 'ip')).toMatchObject({ current: 2 });
    // A different identity keeps its own budget during the outage.
    expect(await incr(store, 'other')).toMatchObject({ current: 1 });
  });

  it('bounds a hanging redis by REDIS_TIMEOUT_MS', async () => {
    const { client } = fakeRedis(hangs);
    const Store = createRateLimitStore(client, { ...config, REDIS_TIMEOUT_MS: 20 }, logSpy());
    const started = Date.now();
    const result = await incr(new Store({}), 'ip');

    expect(result.current).toBe(1);
    expect(Date.now() - started).toBeLessThan(20 + 200);
  });

  it('expires the local window and starts the count again', async () => {
    const { client } = fakeRedis(rejects);
    const Store = createRateLimitStore(client, config, logSpy());
    const store = new Store({});

    expect((await incr(store, 'ip', 10)).current).toBe(1);
    expect((await incr(store, 'ip', 10)).current).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await incr(store, 'ip', 10)).current).toBe(1);
  });

  it('bounds the local fallback map so an outage cannot exhaust the heap', async () => {
    const { client } = fakeRedis(rejects);
    const Store = createRateLimitStore(client, config, logSpy());
    const store = new Store({});

    expect((await incr(store, 'ip')).current).toBe(1);
    for (let i = 0; i < 10_001; i++) await incr(store, `flood-${i}`);
    // Cleared wholesale: the earlier identity's count is gone, not accumulated.
    expect((await incr(store, 'ip')).current).toBe(1);
  });

  it('logs the degrade and the recovery exactly once per transition', async () => {
    let healthy = false;
    const log = logSpy();
    const { client } = fakeRedis(() =>
      healthy ? Promise.resolve<[number, number]>([1, 60_000]) : rejects(),
    );
    const Store = createRateLimitStore(client, config, log);
    const store = new Store({});

    for (let i = 0; i < 5; i++) await incr(store, 'ip');
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();

    healthy = true;
    for (let i = 0; i < 5; i++) await incr(store, 'ip');
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledTimes(1);

    healthy = false;
    for (let i = 0; i < 5; i++) await incr(store, 'ip');
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it('logs the host and port on degrade, never the url or its password', async () => {
    const log = logSpy();
    const { client } = fakeRedis(rejects);
    const Store = createRateLimitStore(client, config, log);
    await incr(new Store({}), 'ip');

    const [fields] = log.warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields).toMatchObject({ host: 'redis.internal', port: 6379 });
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('not-a-real-password');
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('redis://');
  });

  it('counts every decision by store and outcome', async () => {
    const { client } = fakeRedis(ok(1));
    const healthy = createRateLimitStore(client, config, logSpy());
    await incr(new healthy({}), 'ip');

    const broken = createRateLimitStore(fakeRedis(rejects).client, config, logSpy());
    await incr(new broken({}), 'ip');

    const values = (await rateLimitStoreOperations.get()).values.map((v) => ({
      ...v.labels,
      value: v.value,
    }));
    expect(values).toEqual(
      expect.arrayContaining([
        { store: 'redis', outcome: 'ok', value: 1 },
        { store: 'redis', outcome: 'error', value: 1 },
        { store: 'local', outcome: 'ok', value: 1 },
      ]),
    );
  });
});
