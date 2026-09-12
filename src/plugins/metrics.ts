import type { FastifyInstance } from 'fastify';
import client from 'prom-client';
import type { Config } from '../config.js';
import { bearerToken, bearerTokenMatches } from '../lib/bearer-auth.js';
import { unauthorized } from '../lib/errors.js';
import { rateLimitStoreOperations } from '../lib/rate-limit-store.js';
import { spansExported, tracingStatus } from '../telemetry.js';

export function registerMetrics(app: FastifyInstance, config: Config) {
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });

  // Owned by src/telemetry.ts, which runs as a `--import` preload long before
  // this registry exists — hence `registers: []` there and this line here. A
  // rising `failed` while `succeeded` is flat means the collector is rejecting
  // batches, which is otherwise only visible on stderr.
  registry.registerMetric(spansExported);

  // Owned by src/lib/rate-limit-store.ts for the same reason: the store is
  // constructed before this registry exists, because the limiter is registered
  // before the metrics plugin is.
  registry.registerMetric(rateLimitStoreOperations);

  const httpDuration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });

  // A steadily non-zero `replayed` proves retries are being caught; a rising
  // `conflict` means clients reuse keys incorrectly; any `takeover` at all
  // means requests are dying mid-flight.
  const idempotencyRequests = new client.Counter({
    name: 'idempotency_requests_total',
    help: 'Keyed requests by idempotency outcome',
    labelNames: ['outcome'],
    registers: [registry],
  });

  // The signal that matters is the ratio: `requested` climbing while
  // `consumed` stays flat means mail is not arriving or links are expiring.
  // `requested` increments regardless of whether the address matched an
  // account — deliberately, so this counter is not an enumeration oracle.
  const passwordResets = new client.Counter({
    name: 'password_reset_total',
    help: 'Password reset attempts by outcome',
    labelNames: ['outcome'],
    registers: [registry],
  });

  // `issued` climbing while `consumed` stays at zero means either mail is not
  // arriving or nobody can act on it — which, until a real transport exists, is
  // the expected reading in production (ADR 0011). The cooldown path increments
  // nothing, so a flat `resent` is distinguishable from a broken route.
  const emailVerifications = new client.Counter({
    name: 'email_verification_total',
    help: 'Email verification events by outcome',
    labelNames: ['outcome'],
    registers: [registry],
  });

  // The only proof that the un-awaited send actually happened. A rising
  // `failed` is page-worthy: the user already got their 202, so nothing else
  // surfaces it.
  const mailMessages = new client.Counter({
    name: 'mail_messages_total',
    help: 'Outbound mail by kind, transport, and outcome',
    labelNames: ['kind', 'transport', 'outcome'],
    registers: [registry],
  });

  // Incremented by the number of rows actually deleted, so `others` carries how
  // wide each sweep was. A sustained rise in scope="others" across accounts is a
  // population of users finding sessions they do not recognise — a
  // credential-stuffing signal arriving through the front door rather than
  // through the login error rate. No public id and no user agent as a label:
  // one is an identifier, the other is attacker-controlled text.
  const sessionsRevoked = new client.Counter({
    name: 'sessions_revoked_total',
    help: 'Sessions revoked by scope',
    labelNames: ['scope'],
    registers: [registry],
  });

  // `restored` climbing relative to `deleted` is the feature earning its keep:
  // users misclick delete, which is the premise of the whole thing. `purged`
  // flat at zero more than 30 days after launch means the sweep never runs and
  // the retention window is fiction — nothing else in the system says so, and
  // `deleted` climbing while `purged` stays near zero is the accumulation the
  // no-scheduler choice accepts (ADR 0017). `purged` advances by the number of
  // rows actually removed, so it carries how wide each sweep was. No todo id and
  // no title as a label: one is unbounded cardinality, the other is user content.
  const todosSoftDeleted = new client.Counter({
    name: 'todos_soft_delete_total',
    help: 'Todo soft delete lifecycle events by action',
    labelNames: ['action'],
    registers: [registry],
  });

  app.addHook('onResponse', (request, reply, done) => {
    // routerPath keeps cardinality bounded (`/api/todos/:id`, not one label per uuid).
    const route = request.routeOptions.url ?? 'unmatched';
    httpDuration.observe(
      { method: request.method, route, status: String(reply.statusCode) },
      reply.elapsedTime / 1000,
    );
    done();
  });

  // A monitoring endpoint, not a user session: a bearer token compared in
  // constant time, no cookie and no database round trip. An empty token means
  // no scraper credential is configured, which loadConfig only tolerates
  // outside production — see the comment there for why the endpoint is open on
  // a developer machine and closed everywhere else.
  const expectedToken = config.METRICS_TOKEN;
  app.log.info({ metricsAuth: expectedToken ? 'required' : 'disabled' }, 'metrics endpoint ready');

  // Never the endpoint and never the headers — the latter is a credential.
  // `pgInstrumented: false` with tracing enabled is the one misconfiguration
  // that silently halves this feature's value; see ADR 0013.
  const tracing = tracingStatus();
  app.log.info(tracing, 'tracing ready');
  if (tracing.tracing === 'enabled' && !tracing.pgInstrumented) {
    app.log.warn(
      'tracing started without the --import preload: server spans only, no postgres spans. ' +
        'Start the server as `node --import ./dist/telemetry.js dist/index.js`.',
    );
  }

  // "Is the limiter distributed right now" has to be answerable from the logs,
  // because an empty REDIS_URL is a deliberate and invisible state (ADR 0018).
  // Never the URL: it carries a password.
  app.log.info(
    {
      rateLimitStore: config.REDIS_URL ? 'redis' : 'memory',
      max: config.RATE_LIMIT_MAX,
      window: config.RATE_LIMIT_WINDOW,
      authMax: config.AUTH_RATE_LIMIT_MAX,
    },
    'rate limiter ready',
  );

  app.get(
    '/metrics',
    {
      logLevel: 'warn',
      schema: { hide: true },
      // onRequest: rejected before any metric is rendered or logged.
      onRequest: (request, _reply, done) => {
        if (!expectedToken) return done();
        if (!bearerTokenMatches(bearerToken(request.headers.authorization), expectedToken)) {
          return done(unauthorized('Metrics token required'));
        }
        done();
      },
    },
    async (_request, reply) => {
      reply.header('content-type', registry.contentType);
      return registry.metrics();
    },
  );

  return {
    registry,
    idempotencyRequests,
    passwordResets,
    emailVerifications,
    mailMessages,
    sessionsRevoked,
    todosSoftDeleted,
  };
}

export type Metrics = ReturnType<typeof registerMetrics>;
