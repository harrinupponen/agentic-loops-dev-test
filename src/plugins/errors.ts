import type { FastifyError, FastifyInstance } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { AppError } from '../lib/errors.js';

export function registerErrorHandler(app: FastifyInstance) {
  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: { code: 'not_found', message: `Route ${request.method} ${request.url} not found` },
      requestId: request.id,
    });
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      reply.status(400).send({
        error: {
          code: 'validation_failed',
          message: 'Request did not match the expected schema',
          details: error.validation.map((v) => ({
            path: v.instancePath,
            message: v.message,
          })),
        },
        requestId: request.id,
      });
      return;
    }

    if (error instanceof AppError) {
      reply
        .status(error.statusCode)
        .send({ error: { code: error.code, message: error.message }, requestId: request.id });
      return;
    }

    if (error.statusCode && error.statusCode < 500) {
      reply.status(error.statusCode).send({
        error: { code: error.code ?? 'request_error', message: error.message },
        requestId: request.id,
      });
      return;
    }

    // Unexpected: log everything, tell the client nothing.
    request.log.error({ err: error }, 'unhandled error');
    reply.status(500).send({
      error: { code: 'internal_error', message: 'Internal server error' },
      requestId: request.id,
    });
  });
}
