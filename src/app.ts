import { isSpanContextValid, trace } from '@opentelemetry/api';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit, { type FastifyRateLimitStoreCtor } from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import underPressure from '@fastify/under-pressure';
import Fastify, { type FastifyInstance } from 'fastify';
import type Redis from 'ioredis';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { randomUUID } from 'node:crypto';
import { allowedOrigins, type Config } from './config.js';
import type { Database } from './db/client.js';
import { forbidden } from './lib/errors.js';
import { createMailer, type Mailer } from './lib/mailer.js';
import { createRateLimitStore } from './lib/rate-limit-store.js';
import { createRedis } from './lib/redis.js';
import { createTodoListCache } from './lib/todo-list-cache.js';
import { createSessionLoader } from './plugins/auth.js';
import { registerErrorHandler } from './plugins/errors.js';
import { registerIdempotency } from './plugins/idempotency.js';
import { registerMetrics } from './plugins/metrics.js';
import { registerTracing } from './plugins/tracing.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerTodoRoutes } from './routes/todos.js';
import { registerWebRoutes } from './routes/web.js';

declare module 'fastify' {
  interface FastifyInstance {
    isShuttingDown: boolean;
    config: Config;
    /** The shared store, or null when REDIS_URL is empty. See src/lib/redis.ts. */
    redis: Redis | null;
    /**
     * The list cache's own client, or null unless REDIS_URL is set AND
     * TODO_LIST_CACHE_ENABLED is true. Separate from `redis` so a cache command
     * never queues on the socket the rate limiter — a security control on the
     * hot path — is using, and so the two keyspaces stay under their own
     * prefixes.
     */
    cacheRedis: Redis | null;
  }
}

/**
 * Routes whose path parameter must not reach a log line, keyed by route
 * template. A session's public id identifies a credential-bearing row, and
 * F-009 requires that no log line contains one at any level; the access log
 * would otherwise print it as part of the request URL. The route template is
 * still logged as `route`, so cardinality and debuggability are unchanged.
 */
const URL_PARAM_REDACTED = new Set(['/api/auth/sessions/:id']);

/**
 * Redact only the `q` parameter's value, wherever it appears, rather than a
 * route's whole query string: `q` puts user-typed search text in a log line
 * (the same category of content as a todo title, F-013), but `limit`,
 * `cursor`, `completed`, and `deleted` are not sensitive and an operator
 * debugging the busiest route in the app needs them.
 *
 * Four review rounds found four different ways of trying to locate *where*
 * the value sits in the URL string went wrong: a trailing slash routing to a
 * different template than the redaction set expected, a literal `?` inside a
 * value (`url.split('?')` truncates at a second one), `#` (find-my-way splits
 * path from query at whichever of `?` or `#` comes first), and percent-
 * encoding (a value substring-matched against its own encoded form in the
 * URL). The fix is to stop locating the value at all. `query` is Fastify's
 * own already-parsed result, so this function only ever needs to know
 * *whether* Fastify found a `q` — never where in the string or how it was
 * encoded. The `URLSearchParams` pass produces a clean `?q=[redacted]` for
 * the common case and is trusted as-is when it also saw `q`; the only time
 * this function goes looking further is when Fastify parsed a `q` that pass
 * did not see, meaning the value reached the router through some path this
 * function doesn't otherwise understand — and in that one case, it drops the
 * entire query string rather than trying to redact around a value it cannot
 * reliably find.
 */
/** Exported for tests/unit/loggable-url.test.ts — this exact function has had
 * five review-found bugs; a table-driven unit test catches a regression in
 * milliseconds instead of needing a real Postgres-backed integration run. */
export function loggableUrl(url: string, route: string | undefined, query: unknown): string {
  if (route && URL_PARAM_REDACTED.has(route)) return route;

  let candidate = url;
  let cleanPassSawQ = false;
  const mark = url.indexOf('?');
  if (mark !== -1) {
    const params = new URLSearchParams(url.slice(mark + 1));
    if (params.has('q')) {
      cleanPassSawQ = true;
      params.set('q', '[redacted]');
      candidate = `${url.slice(0, mark)}?${params.toString()}`;
    }
  }
  if (cleanPassSawQ) return candidate;

  const parsedQ = (query as Record<string, unknown> | undefined)?.q;
  const fastifySawQ = Array.isArray(parsedQ)
    ? parsedQ.some((v) => typeof v === 'string' && v.length > 0)
    : typeof parsedQ === 'string' && parsedQ.length > 0;
  if (!fastifySawQ) return url;

  const firstDelimiter = url.search(/[?#;]/);
  return firstDelimiter === -1 ? url : url.slice(0, firstDelimiter);
}

export interface BuildOptions {
  /** Redirects the logger somewhere a test can read; defaults to stdout. */
  logStream?: NodeJS.WritableStream;
  /**
   * Overrides the transport built from MAIL_TRANSPORT. This is the only
   * supported way for a test to observe an outgoing message, and the reason no
   * "get my token" route exists anywhere (ADR 0010).
   */
  mailer?: Mailer;
}

export async function buildApp(
  config: Config,
  db: Database,
  options: BuildOptions = {},
): Promise<FastifyInstance> {
  // First, before anything is allocated: an unsafe transport must refuse the
  // boot rather than serve one request. See src/lib/mailer.ts and ADR 0007.
  const mailer = options.mailer ?? createMailer(config);

  const app = Fastify({
    trustProxy: config.TRUST_PROXY,
    // Bounded body size: the default is 1 MiB, made explicit so it is reviewable.
    bodyLimit: 256 * 1024,
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
    logger: {
      level: config.LOG_LEVEL,
      ...(options.logStream ? { stream: options.logStream } : {}),
      // One place, covering `app.log` and `request.log` alike: an operator
      // holding a log line can pivot to the trace, and `app.request_id` on the
      // span pivots back. Adds nothing when tracing is off — the API's no-op
      // span reports an all-zero, invalid trace id.
      mixin: () => {
        const spanContext = trace.getActiveSpan()?.spanContext();
        if (!spanContext || !isSpanContextValid(spanContext)) return {};
        return { traceId: spanContext.traceId, spanId: spanContext.spanId };
      },
      // Structured logs only. Never log cookies, auth headers, or request bodies.
      redact: {
        paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
        remove: true,
      },
      serializers: {
        req: (req) => ({
          method: req.method,
          url: loggableUrl(req.url, req.routeOptions?.url, req.query),
          route: req.routeOptions?.url,
          remoteAddress: req.ip,
        }),
      },
    },
  });

  app.decorate('isShuttingDown', false);
  app.decorate('config', config);

  // null when REDIS_URL is empty, which is every deployed environment today: no
  // client is constructed, no `store` is passed below, and the executed path is
  // the one already running in production (ADR 0018).
  const closeWithApp = (client: Redis) => {
    app.addHook('onClose', async () => {
      try {
        await client.quit();
      } catch {
        // Never connected, or the connection is already gone.
      } finally {
        // Idempotent, and the only thing that makes the socket's death
        // synchronous with app.close() rather than a tick after it.
        client.disconnect();
      }
    });
  };

  const redis = createRedis(config, { keyPrefix: 'rl:', log: app.log });
  app.decorate('redis', redis);
  if (redis) closeWithApp(redis);

  // Off unless both switches are on, which is every deployed environment today:
  // no second client, `todoListCache` is null, every call site in the todo
  // routes short-circuits, and the executed path is byte-for-byte the one that
  // ran before F-012 (ADR 0021).
  const cacheRedis = config.TODO_LIST_CACHE_ENABLED
    ? createRedis(config, { keyPrefix: 'c:', log: app.log })
    : null;
  app.decorate('cacheRedis', cacheRedis);
  if (cacheRedis) closeWithApp(cacheRedis);

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(helmet, {
    // Explicit rather than leaning on the default-src fallback: this is what
    // makes "no inline script, no innerHTML" in the web client enforceable.
    // No 'unsafe-inline' and no 'unsafe-eval' anywhere.
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'"],
        'img-src': ["'self'", 'data:'],
        'connect-src': ["'self'"],
        'base-uri': ["'none'"],
        'form-action': ["'self'"],
        'object-src': ["'none'"],
        'frame-ancestors': ["'none'"],
      },
    },
    hsts:
      config.NODE_ENV === 'production' ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  });

  await app.register(cookie, {
    secret: config.COOKIE_SECRET,
    parseOptions: { httpOnly: true, sameSite: 'lax', path: '/' },
  });

  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW,
    // With no Redis the plugin builds its own per-instance LocalStore, exactly
    // as it did before F-011. With one, the store below counts in Redis and
    // falls back to a local window when it cannot (ADR 0019). The identity is
    // hashed inside the store, so the key generator is unchanged.
    ...(redis
      ? {
          // The shipped types omit the timeWindow and max arguments the plugin
          // actually passes to `incr` (see store/RedisStore.js), so the cast is
          // the library's, not ours.
          store: createRateLimitStore(
            redis,
            config,
            app.log,
          ) as unknown as FastifyRateLimitStoreCtor,
        }
      : {}),
    keyGenerator: (request) => request.user?.id ?? request.ip,
    // @fastify/rate-limit throws whatever this returns and relies on the
    // global error handler to read statusCode/code/message off it — see
    // registerErrorHandler in ./plugins/errors.js. A plain `{ error, requestId }`
    // body has none of those, so it silently became a 500.
    errorResponseBuilder: (_request, context) => ({
      statusCode: context.statusCode,
      code: 'rate_limited',
      message: `Too many requests. Retry in ${context.after}.`,
    }),
  });

  // Sheds load with 503 instead of collapsing when the event loop backs up.
  await app.register(underPressure, {
    maxEventLoopDelay: 1_000,
    maxHeapUsedBytes: 0,
    maxRssBytes: 0,
    retryAfter: 5,
  });

  await app.register(swagger, {
    openapi: {
      info: { title: 'agentic-todo API', version: '0.1.0' },
      tags: [{ name: 'health' }, { name: 'auth' }, { name: 'todos' }],
    },
    transform: jsonSchemaTransform,
  });

  registerErrorHandler(app);
  const metrics = registerMetrics(app, config);

  const origins = allowedOrigins(config);
  if (origins.length > 0) {
    // Cookie-auth CSRF defence: reject cross-origin state changes outright.
    app.addHook('onRequest', (request, _reply, done) => {
      const method = request.method.toUpperCase();
      if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return done();
      const origin = request.headers.origin;
      if (origin && !origins.includes(origin)) {
        return done(forbidden('Cross-origin request rejected'));
      }
      done();
    });
  }

  // Runs at onRequest, before body schema validation, so an unauthenticated
  // request is rejected before it reveals anything about the expected shape.
  app.addHook('onRequest', createSessionLoader(db));

  // Immediately after the session loader, so the span covers the handler and
  // every query it makes, and reads nothing from `request.user`.
  registerTracing(app);

  const idempotency = registerIdempotency(app, db, config, metrics.idempotencyRequests);

  registerHealthRoutes(app, db);
  registerAuthRoutes(app, db, config, mailer, metrics);
  // Under the existing `auth` tag, so the tag list above is unchanged.
  registerSessionRoutes(app, db, config, metrics);
  const todoListCache = cacheRedis ? createTodoListCache(cacheRedis, config, app.log) : null;
  registerTodoRoutes(app, db, idempotency, metrics, todoListCache);
  // Last, and able to refuse the boot: see the two rules in src/routes/web.ts.
  await registerWebRoutes(app, config);

  await app.ready();
  return app;
}
