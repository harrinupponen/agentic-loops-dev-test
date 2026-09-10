import type { Span } from '@opentelemetry/api';
import 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    /** The SERVER span for this request; only set for traced routes. */
    otelSpan?: Span;
    user?: { id: string; email: string; emailVerified: boolean };
    sessionId?: string;
    /** Set once this request owns an idempotency key; read by the onSend hook. */
    idempotency?: { userId: string; key: string };
  }
}
