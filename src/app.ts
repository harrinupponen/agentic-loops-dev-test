import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import underPressure from '@fastify/under-pressure';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { randomUUID } from 'node:crypto';
import { allowedOrigins, type Config } from './config.js';
import type { Database } from './db/client.js';
import { forbidden } from './lib/errors.js';
import { createSessionLoader } from './plugins/auth.js';
import { registerErrorHandler } from './plugins/errors.js';
import { registerIdempotency } from './plugins/idempotency.js';
import { registerMetrics } from './plugins/metrics.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerTodoRoutes } from './routes/todos.js';

declare module 'fastify' {
  interface FastifyInstance {
    isShuttingDown: boolean;
    config: Config;
  }
}

export async function buildApp(config: Config, db: Database): Promise<FastifyInstance> {
  const app = Fastify({
    trustProxy: config.TRUST_PROXY,
    // Bounded body size: the default is 1 MiB, made explicit so it is reviewable.
    bodyLimit: 256 * 1024,
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
    logger: {
      level: config.LOG_LEVEL,
      // Structured logs only. Never log cookies, auth headers, or request bodies.
      redact: {
        paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
        remove: true,
      },
      serializers: {
        req: (req) => ({
          method: req.method,
          url: req.url,
          route: req.routeOptions?.url,
          remoteAddress: req.ip,
        }),
      },
    },
  });

  app.decorate('isShuttingDown', false);
  app.decorate('config', config);

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: { 'default-src': ["'self'"], 'frame-ancestors': ["'none'"] },
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
    // In-memory store is per-instance. Swap for the Redis store once you run
    // more than one machine and the limit needs to be global (see specs F-011).
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
  const metrics = registerMetrics(app);

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

  const idempotency = registerIdempotency(app, db, config, metrics.idempotencyRequests);

  registerHealthRoutes(app, db);
  registerAuthRoutes(app, db, config);
  registerTodoRoutes(app, db, idempotency);

  await app.ready();
  return app;
}
