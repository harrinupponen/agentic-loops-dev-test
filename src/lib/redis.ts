import Redis from 'ioredis';
import type { FastifyBaseLogger } from 'fastify';
import { createHmac } from 'node:crypto';
import type { Config } from '../config.js';

export interface CreateRedisOptions {
  /**
   * Namespace prepended to every key by the client, so two features can share
   * one server without colliding: `rl:` for the rate limiter, something else
   * for the cache that comes next.
   */
  keyPrefix?: string;
  /** Connection errors are logged with `{ host, port }` — never the URL. */
  log?: Pick<FastifyBaseLogger, 'warn'>;
}

/**
 * Keyed, not plain: an unsalted SHA-256 of an IPv4 address is reversible by
 * brute force in seconds, and the point is that the shared store holds no raw
 * address and no user id. COOKIE_SECRET is already required, already at least
 * 32 characters, and already per-environment, so staging and production cannot
 * collide even if they are ever pointed at one Redis by mistake.
 *
 * Shared by every feature that puts a key in Redis — the rate limiter and the
 * todo list cache — so the keyspace has one derivation, not two.
 */
export function hashIdentity(secret: string, identity: string): string {
  return createHmac('sha256', secret).update(identity).digest('hex').slice(0, 32);
}

/** A hung command is a failed command as far as a request is concerned. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('redis command timed out')), ms);
      timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Host and port, which are safe to log; the URL carries a password and is not. */
export function redisTarget(url: string): { host: string; port: number } {
  const parsed = new URL(url);
  return { host: parsed.hostname, port: Number(parsed.port) || 6379 };
}

/**
 * One ioredis client per process, or `null` when REDIS_URL is empty — which is
 * the value in every deployed environment today (ADR 0018). Nothing here is
 * specific to rate limiting: this is the shared connection any feature that
 * needs Redis is expected to build on.
 *
 * The options are the whole design of the failure behaviour (ADR 0019): while
 * disconnected, commands reject immediately instead of queueing, and a slow
 * answer is a failed answer. That is the circuit breaker, obtained from the
 * client library rather than hand-rolled.
 */
export function createRedis(
  config: Pick<Config, 'REDIS_URL' | 'REDIS_TIMEOUT_MS'>,
  options: CreateRedisOptions = {},
): Redis | null {
  if (!config.REDIS_URL) return null;

  const client = new Redis(config.REDIS_URL, {
    // The circuit breaker: a disconnected client fails a command now rather
    // than queueing it behind a reconnect the request cannot wait for.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: config.REDIS_TIMEOUT_MS,
    // Reconnects happen in the background and never block a request.
    connectTimeout: 1_000,
    // buildApp returns even when Redis is down; the first request degrades.
    lazyConnect: true,
    retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
    ...(options.keyPrefix === undefined ? {} : { keyPrefix: options.keyPrefix }),
  });

  const target = redisTarget(config.REDIS_URL);
  // Required: an ioredis client with no `error` listener throws on the process.
  client.on('error', (error: Error) => {
    options.log?.warn({ ...target, err: error.message }, 'redis connection error');
  });

  // Unawaited on purpose. `lazyConnect` keeps construction from blocking on a
  // store that may be down, but with no offline queue a command issued before
  // the socket exists is rejected — so without this the first request after
  // every boot would degrade for want of a connection nobody asked for yet.
  // A failure here is already logged above, and retryStrategy keeps trying.
  void client.connect().catch(() => {});

  return client;
}
