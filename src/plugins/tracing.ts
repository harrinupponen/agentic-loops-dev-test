import { SpanKind, SpanStatusCode, context, propagation, trace } from '@opentelemetry/api';
import {
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
} from '@opentelemetry/semantic-conventions';
import type { FastifyInstance } from 'fastify';

/**
 * The server span, hand-written rather than taken from `instrumentation-http`
 * or `instrumentation-fastify`: see docs/adr/0013-server-spans-are-ours.md.
 * Fastify already knows the route template here, and the attributes below are
 * an allowlist rather than a scrubber applied to whatever a library decided to
 * record. Spans are the one signal designed to leave the perimeter.
 */

const TRACER_NAME = 'agentic-todo';

/** The join key back to logs and to the error envelope's `requestId`. */
const ATTR_APP_REQUEST_ID = 'app.request_id';

/**
 * Health, readiness, `/metrics` and static assets are the highest-volume and
 * least interesting requests this server handles; an unmatched request has no
 * template at all and would put a raw path on a span.
 */
export function isTracedRoute(url: string | undefined): boolean {
  return typeof url === 'string' && url.startsWith('/api/');
}

export function registerTracing(app: FastifyInstance): void {
  app.addHook('onRequest', (request, _reply, done) => {
    const route = request.routeOptions.url;
    if (!isTracedRoute(route)) return done();

    // A malformed traceparent is dropped by the propagator rather than raising;
    // the sampler ignores the remote sampling decision either way.
    const parent = propagation.extract(context.active(), request.headers);
    const span = trace.getTracer(TRACER_NAME).startSpan(
      `${request.method} ${route}`,
      {
        kind: SpanKind.SERVER,
        // Exhaustive, and closed by an integration test.
        attributes: {
          [ATTR_HTTP_REQUEST_METHOD]: request.method,
          [ATTR_HTTP_ROUTE]: route,
          [ATTR_APP_REQUEST_ID]: request.id,
        },
      },
      parent,
    );

    request.otelSpan = span;
    // Everything downstream — the remaining hooks, the handler, the error
    // handler, the pino mixin, and every `pg` query — runs inside this context.
    context.with(trace.setSpan(parent, span), done);
  });

  app.addHook('onError', (request, _reply, error, done) => {
    const span = request.otelSpan;
    // A 4xx is the API working. Only our own failures are the span's failure.
    const statusCode = typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (span && statusCode >= 500) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR });
    }
    done();
  });

  app.addHook('onResponse', (request, reply, done) => {
    const span = request.otelSpan;
    if (!span) return done();
    request.otelSpan = undefined;

    span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, reply.statusCode);
    if (reply.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();
    done();
  });
}
