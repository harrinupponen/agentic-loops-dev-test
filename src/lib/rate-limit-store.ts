import type { FastifyBaseLogger } from 'fastify';
import type Redis from 'ioredis';
import client from 'prom-client';
import type { Config } from '../config.js';
import { hashIdentity, redisTarget, withTimeout } from './redis.js';

// Both live in ./redis.js so the cache and the limiter share one derivation and
// one timeout, rather than growing a second copy each. Re-exported because this
// is where callers have always imported hashIdentity from.
export { hashIdentity };

/**
 * The single signal that says whether the limiter is distributed right now.
 * `{store="local"}` rising while REDIS_URL is set is degraded mode and is the
 * page-worthy shape; both flat while traffic flows means the store is not being
 * consulted at all. Registered on the app's registry by src/plugins/metrics.ts,
 * the same way src/telemetry.ts hands over its counter.
 */
export const rateLimitStoreOperations = new client.Counter({
  name: 'rate_limit_store_operations_total',
  help: 'Rate limit store decisions by store and outcome',
  labelNames: ['store', 'outcome'],
  registers: [],
});

/**
 * The script @fastify/rate-limit's own RedisStore uses (store/RedisStore.js).
 * One round trip, atomic, no read-modify-write race between instances. The key
 * arrives as KEYS[1] and is hex from an HMAC — nothing is concatenated in.
 */
const LUA = `
  local key = KEYS[1]
  local timeWindow = tonumber(ARGV[1])
  local max = tonumber(ARGV[2])
  local continueExceeding = ARGV[3] == 'true'
  local exponentialBackoff = ARGV[4] == 'true'
  local MAX_SAFE_INTEGER = (2^53) - 1

  local current = redis.call('INCR', key)

  if current == 1 or (continueExceeding and current > max) then
    redis.call('PEXPIRE', key, timeWindow)
  elseif exponentialBackoff and current > max then
    local backoffExponent = current - max - 1
    timeWindow = math.min(timeWindow * (2 ^ backoffExponent), MAX_SAFE_INTEGER)
    redis.call('PEXPIRE', key, timeWindow)
  else
    timeWindow = redis.call('PTTL', key)
  end

  return {current, timeWindow}
`;

/** Cleared wholesale beyond this: the fallback must not become the outage. */
const MAX_LOCAL_ENTRIES = 10_000;

export interface RateLimitResult {
  current: number;
  ttl: number;
}

type IncrCallback = (error: Error | null, result?: RateLimitResult) => void;

interface StoreParams {
  continueExceeding?: boolean;
  exponentialBackoff?: boolean;
}

interface ChildParams extends StoreParams {
  routeInfo?: { method?: string; url?: string };
}

type RateLimitCommand = (
  key: string,
  timeWindow: number,
  max: number,
  continueExceeding: boolean,
  exponentialBackoff: boolean,
) => Promise<[number, number]>;

interface LocalEntry {
  current: number;
  ttl: number;
  startedAt: number;
}

type StoreConfig = Pick<Config, 'REDIS_URL' | 'REDIS_TIMEOUT_MS' | 'COOKIE_SECRET'>;

/**
 * The @fastify/rate-limit store that counts in Redis and, when Redis cannot
 * answer, counts in a per-instance window instead — degraded, never unlimited,
 * never a 500 (docs/adr/0019-a-rate-limiter-degrades-rather-than-fails.md).
 *
 * This class exists instead of the library's `redis` option because
 * `skipOnError` cannot express "count somewhere else": `false`, its default,
 * turns a Redis blip into a 500 on every request, and `true` deletes the
 * limiter for the duration of the outage.
 */
export function createRateLimitStore(
  redis: Redis,
  config: StoreConfig,
  log: Pick<FastifyBaseLogger, 'warn' | 'info'>,
) {
  const target = redisTarget(config.REDIS_URL);
  // Shared by every child store, so an outage is one warn for the process
  // rather than one per route and never one per request.
  const health = { degraded: false };

  const command = redis as Redis & { rateLimit?: RateLimitCommand };
  if (!command.rateLimit) redis.defineCommand('rateLimit', { numberOfKeys: 1, lua: LUA });
  const rateLimit = (...args: Parameters<RateLimitCommand>) => command.rateLimit!(...args);

  return class RedisRateLimitStore {
    private readonly continueExceeding: boolean;
    private readonly exponentialBackoff: boolean;
    private readonly window = new Map<string, LocalEntry>();

    constructor(
      params: StoreParams,
      /** `${method}${url}-` for a route with its own limit, empty for the global one. */
      private readonly prefix = '',
    ) {
      this.continueExceeding = params.continueExceeding ?? false;
      this.exponentialBackoff = params.exponentialBackoff ?? false;
    }

    incr(key: string, callback: IncrCallback, timeWindow: number, max: number): void {
      const identity = this.prefix + hashIdentity(config.COOKIE_SECRET, key);
      // `count` resolves on every path, including a store failure: the error
      // never reaches the plugin, so it never reaches the error handler.
      void this.count(identity, timeWindow, max).then((result) => callback(null, result));
    }

    child(routeOptions: ChildParams): RedisRateLimitStore {
      const { method = '', url = '' } = routeOptions.routeInfo ?? {};
      // Keeps POST /api/auth/login's tighter limit out of the global bucket.
      return new RedisRateLimitStore(routeOptions, `${this.prefix}${method}${url}-`);
    }

    private async count(key: string, timeWindow: number, max: number): Promise<RateLimitResult> {
      try {
        const [current, ttl] = await withTimeout(
          rateLimit(key, timeWindow, max, this.continueExceeding, this.exponentialBackoff),
          config.REDIS_TIMEOUT_MS,
        );
        rateLimitStoreOperations.inc({ store: 'redis', outcome: 'ok' });
        if (health.degraded) {
          health.degraded = false;
          log.info(target, 'rate limiter recovered: the shared store is answering again');
        }
        return { current: Number(current), ttl: Number(ttl) };
      } catch (error) {
        rateLimitStoreOperations.inc({ store: 'redis', outcome: 'error' });
        if (!health.degraded) {
          health.degraded = true;
          log.warn(
            { ...target, err: (error as Error).message },
            'rate limiter degraded to a per-instance window: the shared store is unreachable',
          );
        }
        const result = this.local(key, timeWindow, max);
        rateLimitStoreOperations.inc({ store: 'local', outcome: 'ok' });
        return result;
      }
    }

    /** The semantics of the plugin's own LocalStore, bounded. */
    private local(key: string, timeWindow: number, max: number): RateLimitResult {
      const now = Date.now();
      // It only fills during an outage, and an attacker rotating identities
      // influences how fast. A cleared window costs a restarted count; an
      // exhausted heap costs the process.
      if (this.window.size > MAX_LOCAL_ENTRIES) this.window.clear();

      const entry = this.window.get(key);
      if (!entry || entry.startedAt + timeWindow <= now) {
        const fresh = { current: 1, ttl: timeWindow, startedAt: now };
        this.window.set(key, fresh);
        return { current: fresh.current, ttl: fresh.ttl };
      }

      entry.current += 1;
      if (this.continueExceeding && entry.current > max) {
        entry.ttl = timeWindow;
        entry.startedAt = now;
      } else if (this.exponentialBackoff && entry.current > max) {
        const ttl = timeWindow * 2 ** (entry.current - max - 1);
        entry.ttl = Number.isSafeInteger(ttl) ? ttl : Number.MAX_SAFE_INTEGER;
        entry.startedAt = now;
      } else {
        entry.ttl = timeWindow - (now - entry.startedAt);
      }
      return { current: entry.current, ttl: entry.ttl };
    }
  };
}
