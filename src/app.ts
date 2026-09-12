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

function loggableUrl(url: string, route: string | undefined): string {
  if (!route || !URL_PARAM_REDACTED.has(route)) return url;
  // Replace the concrete value with the template's placeholder, keeping any
  // query string off the line entirely.
  return route;
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
          url: loggableUrl(req.url, req.routeOptions?.url),
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
  const redis = createRedis(config, { keyPrefix: 'rl:', log: app.log });
  app.decorate('redis', redis);
  if (redis) {
    app.addHook('onClose', async () => {
      try {
        await redis.quit();
      } catch {
        // Never connected, or the connection is already gone.
      } finally {
        // Idempotent, and the only thing that makes the socket's death
        // synchronous with app.close() rather than a tick after it.
        redis.disconnect();
      }
    });
  }

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
  registerTodoRoutes(app, db, idempotency, metrics);
  // Last, and able to refuse the boot: see the two rules in src/routes/web.ts.
  await registerWebRoutes(app, config);

  await app.ready();
  return app;
}
