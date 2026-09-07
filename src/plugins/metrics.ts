import type { FastifyInstance } from 'fastify';
import client from 'prom-client';

export function registerMetrics(app: FastifyInstance) {
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });

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

  // The only proof that the un-awaited send actually happened. A rising
  // `failed` is page-worthy: the user already got their 202, so nothing else
  // surfaces it.
  const mailMessages = new client.Counter({
    name: 'mail_messages_total',
    help: 'Outbound mail by kind, transport, and outcome',
    labelNames: ['kind', 'transport', 'outcome'],
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

  app.get('/metrics', { logLevel: 'warn', schema: { hide: true } }, async (_request, reply) => {
    reply.header('content-type', registry.contentType);
    return registry.metrics();
  });

  return { registry, idempotencyRequests, passwordResets, mailMessages };
}

export type Metrics = ReturnType<typeof registerMetrics>;
