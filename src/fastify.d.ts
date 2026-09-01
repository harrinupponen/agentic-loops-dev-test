import 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    user?: { id: string; email: string };
    sessionId?: string;
    /** Set once this request owns an idempotency key; read by the onSend hook. */
    idempotency?: { userId: string; key: string };
  }
}
