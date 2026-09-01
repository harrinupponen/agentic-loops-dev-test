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

  return { registry, idempotencyRequests };
}

export type Metrics = ReturnType<typeof registerMetrics>;
