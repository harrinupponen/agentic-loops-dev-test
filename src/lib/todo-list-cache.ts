import type { FastifyBaseLogger } from 'fastify';
import type Redis from 'ioredis';
import client from 'prom-client';
import type { Config } from '../config.js';
import { TodoListResponse, type TodoListBody } from '../routes/todos.js';
import { hashIdentity, redisTarget, withTimeout } from './redis.js';

/**
 * The one series this feature needs. The hit ratio (`hit / (hit + miss)`) says
 * whether the cache is earning its keep; `{operation="invalidate",
 * outcome="error"}` is the only counter in the system that can rise while users
 * are being shown stale data, and is therefore the page-worthy one;
 * `outcome="invalid"` rising after a deploy means a shape changed without the
 * `v1` tag being bumped. Registered on the app's registry by
 * src/plugins/metrics.ts, the same way src/lib/rate-limit-store.ts hands its
 * counter over.
 */
export const todoListCacheOperations = new client.Counter({
  name: 'todo_list_cache_operations_total',
  help: 'Todo list cache operations by operation and outcome',
  labelNames: ['operation', 'outcome'],
  registers: [],
});

/**
 * Fields per user, dropped wholesale beyond this. `limit` is validated to
 * 1..100 and the other two dimensions have 2 and 3 values, so a user can mint
 * 600 variants of their own hash; a cache that ends the process by exhausting
 * memory would be a worse outage than the latency it was removing. Same shape,
 * for the same reason, as the rate limiter's bounded fallback map.
 */
const MAX_FIELDS = 16;

/**
 * One round trip, and the field cap is atomic with the write. The field name
 * and the body arrive as ARGV and are never concatenated into the script.
 */
const LUA = `
  if redis.call('HLEN', KEYS[1]) >= tonumber(ARGV[3]) then redis.call('DEL', KEYS[1]) end
  redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[4]))
`;

/** Every dimension of the list query except `cursor`, which is never cached. */
export interface TodoListVariant {
  deleted: boolean;
  completed?: boolean | undefined;
  limit: number;
}

/**
 * `v1:{live|trash}:{any|done|open}:{limit}`. The `deleted` dimension is in the
 * name because ADR 0016 named the bug in advance: a key without it serves the
 * trash to the live view. `v1` is the coarse format version — a future change to
 * TodoView bumps it, and old fields become unreachable and expire.
 */
export function cacheField(variant: TodoListVariant): string {
  const view = variant.deleted ? 'trash' : 'live';
  const state = variant.completed === undefined ? 'any' : variant.completed ? 'done' : 'open';
  return `v1:${view}:${state}:${variant.limit}`;
}

/** One hash per user. `c:` is the client's keyPrefix, so the full key is `c:todos:{hash}`. */
export function cacheKey(secret: string, userId: string): string {
  return `todos:${hashIdentity(secret, userId)}`;
}

type CacheConfig = Pick<
  Config,
  'REDIS_URL' | 'REDIS_TIMEOUT_MS' | 'COOKIE_SECRET' | 'TODO_LIST_CACHE_TTL_SECONDS'
>;

type SetCommand = (
  key: string,
  field: string,
  body: string,
  maxFields: number,
  ttlMs: number,
) => Promise<unknown>;

/**
 * Every line that touches Redis for the list cache, so src/routes/todos.ts never
 * sees a Redis error, a timeout, or a serialisation concern.
 *
 * Nothing here throws. A Redis error, a timeout, an unparseable entry, and an
 * entry that fails the response schema are all a miss on the read path and a
 * no-op on the write path — the request produces exactly the response it would
 * have produced with the cache off
 * (docs/adr/0021-an-unreachable-cache-is-a-cache-miss.md).
 */
export function createTodoListCache(
  redis: Redis,
  config: CacheConfig,
  log: Pick<FastifyBaseLogger, 'warn' | 'info'>,
) {
  const target = redisTarget(config.REDIS_URL);
  // One warn for an outage and one info for the recovery, never one per request.
  const health = { degraded: false };
  const ttlMs = config.TODO_LIST_CACHE_TTL_SECONDS * 1000;

  const command = redis as Redis & { todoListCacheSet?: SetCommand };
  if (!command.todoListCacheSet) {
    redis.defineCommand('todoListCacheSet', { numberOfKeys: 1, lua: LUA });
  }

  function healthy(): void {
    if (!health.degraded) return;
    health.degraded = false;
    log.info(target, 'todo list cache recovered: the store is answering again');
  }

  /** Counts the failure, logs the transition, and swallows the error. */
  function failed(operation: string, error: unknown): void {
    todoListCacheOperations.inc({ operation, outcome: 'error' });
    if (health.degraded) return;
    health.degraded = true;
    log.warn(
      { ...target, err: (error as Error).message },
      'todo list cache degraded: the store is unreachable, requests fall through to postgres',
    );
  }

  const key = (userId: string) => cacheKey(config.COOKIE_SECRET, userId);

  return {
    /** The cached body, or undefined for a miss — including every failure. */
    async get(userId: string, variant: TodoListVariant): Promise<TodoListBody | undefined> {
      let raw: string | null;
      try {
        raw = await withTimeout(
          redis.hget(key(userId), cacheField(variant)),
          config.REDIS_TIMEOUT_MS,
        );
        healthy();
      } catch (error) {
        failed('get', error);
        return undefined;
      }

      if (raw === null) {
        todoListCacheOperations.inc({ operation: 'get', outcome: 'miss' });
        return undefined;
      }

      // Re-validated against the route's own response schema before it is
      // served: an entry written by a previous release, or one that has been
      // tampered with, is a miss rather than a malformed 200.
      const parsed = TodoListResponse.safeParse(safeJson(raw));
      if (!parsed.success) {
        todoListCacheOperations.inc({ operation: 'get', outcome: 'invalid' });
        return undefined;
      }
      todoListCacheOperations.inc({ operation: 'get', outcome: 'hit' });
      return parsed.data;
    },

    /**
     * Write-back, awaited rather than fired and forgotten: a floating promise is
     * a lint failure here, and an error that lands after the response has no
     * request to be attributed to.
     */
    async set(userId: string, variant: TodoListVariant, body: TodoListBody): Promise<void> {
      try {
        // Through the schema on the way in as well, so what is stored is the
        // response body and not the wider database row behind it — no user_id
        // and no column a future migration adds ever reaches Redis.
        const value = JSON.stringify(TodoListResponse.parse(body));
        await withTimeout(
          command.todoListCacheSet!(key(userId), cacheField(variant), value, MAX_FIELDS, ttlMs),
          config.REDIS_TIMEOUT_MS,
        );
        todoListCacheOperations.inc({ operation: 'set', outcome: 'ok' });
        healthy();
      } catch (error) {
        failed('set', error);
      }
    },

    /**
     * Discards every cached variant for one user in one command (ADR 0020).
     * Cannot throw: the row is already committed in Postgres, and turning a
     * successful write into a 5xx would make the client retry something that
     * already happened. A failure is bounded by the TTL.
     */
    async invalidate(userId: string): Promise<void> {
      try {
        await withTimeout(redis.del(key(userId)), config.REDIS_TIMEOUT_MS);
        todoListCacheOperations.inc({ operation: 'invalidate', outcome: 'ok' });
        healthy();
      } catch (error) {
        failed('invalidate', error);
      }
    },
  };
}

/** A value that is not JSON is a miss, never a throw. */
function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export type TodoListCache = ReturnType<typeof createTodoListCache>;
