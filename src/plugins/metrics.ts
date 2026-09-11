import type { FastifyInstance } from 'fastify';
import client from 'prom-client';
import type { Config } from '../config.js';
import { bearerToken, bearerTokenMatches } from '../lib/bearer-auth.js';
import { unauthorized } from '../lib/errors.js';
import { spansExported, tracingStatus } from '../telemetry.js';

export function registerMetrics(app: FastifyInstance, config: Config) {
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });

  // Owned by src/telemetry.ts, which runs as a `--import` preload long before
  // this registry exists — hence `registers: []` there and this line here. A
  // rising `failed` while `succeeded` is flat means the collector is rejecting
  // batches, which is otherwise only visible on stderr.
  registry.registerMetric(spansExported);

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
  };
}

export type Metrics = ReturnType<typeof registerMetrics>;
