import { SpanKind, SpanStatusCode, propagation, trace } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-node';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createDb } from '../../src/db/client.js';
import { tracingStatus } from '../../src/telemetry.js';
import {
  NO_WEB_CLIENT,
  TEST_METRICS_TOKEN,
  createTestContext,
  metricsAuth,
  registerUser,
  resetDb,
  type TestContext,
} from './helpers.js';

/**
 * The three request-time attributes ADR 0013 allows, plus the response status
 * code the span picks up in `onResponse`. This set is exhaustive on purpose:
 * adding a fourth attribute has to be a deliberate act with a failing test in
 * front of it, because a span is the one signal designed to leave the perimeter.
 */
const ALLOWED_SPAN_ATTRIBUTES = [
  'app.request_id',
  'http.request.method',
  'http.response.status_code',
  'http.route',
].sort();

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

let ctx: TestContext;
let cookie: string;

const serverSpans = (): ReadableSpan[] =>
  exporter.getFinishedSpans().filter((span) => span.kind === SpanKind.SERVER);

const onlySpan = (): ReadableSpan => {
  const spans = serverSpans();
  expect(spans).toHaveLength(1);
  return spans[0]!;
};

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.close();
});

/**
 * Runs before the provider is registered, which is exactly the deployed
 * configuration: `OTEL_EXPORTER_OTLP_ENDPOINT` is empty everywhere (ADR 0012),
 * so `src/telemetry.ts` constructs nothing and the API's global tracer stays
 * the no-op one.
 */
describe('tracing is inert when no endpoint is configured', () => {
  it('registers no tracer provider, records no span, and changes no response', async () => {
    await resetDb(ctx.db);
    const lines: string[] = [];
    const stream = new PassThrough();
    stream.on('data', (chunk: Buffer) => lines.push(chunk.toString()));
    const quiet = await createTestContext({ LOG_LEVEL: 'info' }, { logStream: stream });

    try {
      expect(tracingStatus().tracing).toBe('disabled');
      // No global provider: every span the hooks start is non-recording.
      expect(trace.getTracer('probe').startSpan('probe').isRecording()).toBe(false);

      const session = await registerUser(quiet.app);
      const res = await quiet.app.inject({
        method: 'POST',
        url: '/api/todos',
        headers: { cookie: session.cookie },
        payload: { title: 'inert' },
      });

      expect(res.statusCode).toBe(201);
      expect(exporter.getFinishedSpans()).toHaveLength(0);

      const entries = lines
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.some((entry) => 'traceId' in entry)).toBe(false);
    } finally {
      await quiet.close();
    }
  });
});

describe('server spans', () => {
  beforeAll(async () => {
    provider.register();
    await resetDb(ctx.db);
    cookie = (await registerUser(ctx.app)).cookie;
  });

  afterAll(async () => {
    // Leave the process as it was found: the integration suite shares one fork.
    trace.disable();
    propagation.disable();
    await provider.shutdown();
  });

  beforeEach(() => {
    exporter.reset();
  });

  it('emits one server span per API request', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/todos',
      headers: { cookie },
      payload: { title: 'traced' },
    });
    expect(res.statusCode).toBe(201);

    const span = onlySpan();
    expect(span.name).toBe('POST /api/todos');
    expect(span.kind).toBe(SpanKind.SERVER);
    expect(span.attributes['http.route']).toBe('/api/todos');
    expect(span.attributes['http.request.method']).toBe('POST');
    expect(span.attributes['http.response.status_code']).toBe(201);
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('the span carries the request id used in responses', async () => {
    // A validation failure, so the envelope carrying the request id is the same
    // one an operator would be holding when they go looking for the trace.
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/todos',
      headers: { cookie },
      payload: { title: '' },
    });
    expect(res.statusCode).toBe(400);

    const { requestId } = res.json<{ requestId: string }>();
    const span = onlySpan();
    expect(requestId).toBeTruthy();
    expect(span.attributes['app.request_id']).toBe(requestId);
    // A 4xx is the API working, not a failed span.
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('server spans carry only allowlisted attributes', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/todos',
      headers: { cookie },
      payload: { title: 'secret-title' },
    });
    const todo = created.json<{ id: string }>();
    exporter.reset();

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/todos?completed=false&limit=5&token=should-not-appear`,
      headers: { cookie, 'user-agent': 'probe/1.0', 'x-forwarded-for': '203.0.113.9' },
    });
    expect(res.statusCode).toBe(200);

    const span = onlySpan();
    expect(Object.keys(span.attributes).sort()).toEqual(ALLOWED_SPAN_ATTRIBUTES);

    const serialized = JSON.stringify(span.attributes);
    for (const forbidden of [
      'should-not-appear',
      'completed=false',
      'user-agent',
      'probe/1.0',
      '203.0.113.9',
      'session',
      '@example.com',
      todo.id,
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('traces an unauthenticated request without recording anything about it', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/todos' });
    expect(res.statusCode).toBe(401);

    const span = onlySpan();
    expect(span.name).toBe('GET /api/todos');
    expect(span.attributes['http.response.status_code']).toBe(401);
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    expect(Object.keys(span.attributes).sort()).toEqual(ALLOWED_SPAN_ATTRIBUTES);
  });

  it("records the route template, not the id, for another user's todo", async () => {
    const owner = await registerUser(ctx.app, `owner-${Date.now()}@example.com`);
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/todos',
      headers: { cookie: owner.cookie },
      payload: { title: 'not yours' },
    });
    const todo = created.json<{ id: string }>();
    exporter.reset();

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/todos/${todo.id}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);

    const span = onlySpan();
    expect(span.name).toBe('GET /api/todos/:id');
    expect(span.attributes['http.route']).toBe('/api/todos/:id');
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    expect(JSON.stringify(span.attributes)).not.toContain(todo.id);
    expect(JSON.stringify(span.attributes)).not.toContain(owner.user.email);
  });

  it('adopts an inbound traceparent', async () => {
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const parentSpanId = '00f067aa0ba902b7';

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/todos',
      headers: { cookie, traceparent: `00-${traceId}-${parentSpanId}-01` },
    });
    expect(res.statusCode).toBe(200);
    // Never echoed back: this cannot be used as a reflection channel.
    expect(res.headers.traceparent).toBeUndefined();

    const span = onlySpan();
    expect(span.spanContext().traceId).toBe(traceId);
    expect(span.parentSpanContext?.spanId).toBe(parentSpanId);
  });

  it('logs carry the trace id', async () => {
    const lines: string[] = [];
    const stream = new PassThrough();
    stream.on('data', (chunk: Buffer) => lines.push(chunk.toString()));
    const logged = await createTestContext({ LOG_LEVEL: 'info' }, { logStream: stream });

    try {
      const session = await registerUser(logged.app);
      exporter.reset();
      const res = await logged.app.inject({
        method: 'GET',
        url: '/api/todos',
        headers: { cookie: session.cookie },
      });
      expect(res.statusCode).toBe(200);

      const span = onlySpan();
      const correlated = lines
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((entry) => entry.traceId === span.spanContext().traceId);

      expect(correlated.length).toBeGreaterThan(0);
      expect(correlated.some((entry) => entry.spanId === span.spanContext().spanId)).toBe(true);
    } finally {
      await logged.close();
    }
  });

  it('does not trace health, readiness, metrics, or static assets', async () => {
    const web = await createTestContext({
      WEB_ROOT: 'tests/fixtures/web',
      ALLOWED_ORIGINS: 'http://localhost:3000',
    });

    try {
      for (const url of ['/healthz', '/readyz', '/', '/app/main.js']) {
        const res = await web.app.inject({ url });
        expect(res.statusCode).toBe(200);
      }
      const metrics = await web.app.inject({ url: '/metrics', headers: metricsAuth() });
      expect(metrics.statusCode).toBe(200);

      expect(exporter.getFinishedSpans()).toHaveLength(0);
    } finally {
      await web.close();
    }
  });

  it('marks only 5xx as failed, with the exception recorded', async () => {
    // A real failure rather than a synthetic route: the pool is gone, so the
    // insert inside the handler throws and the error handler turns it into a 500.
    const config = loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      COOKIE_SECRET: 'test-cookie-secret-that-is-long-enough-x',
      RATE_LIMIT_MAX: '10000',
      SHUTDOWN_GRACE_MS: '0',
      ALLOWED_ORIGINS: '',
      MAIL_TRANSPORT: 'drop',
      METRICS_TOKEN: TEST_METRICS_TOKEN,
      WEB_ROOT: NO_WEB_CLIENT,
    });
    const { pool, db } = createDb(config.DATABASE_URL, 2);
    const broken = await buildApp(config, db);

    try {
      await pool.end();
      exporter.reset();

      const res = await broken.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          email: `boom-${Date.now()}@example.com`,
          password: 'correct-horse-battery-staple',
        },
      });
      expect(res.statusCode).toBe(500);

      const span = onlySpan();
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.attributes['http.response.status_code']).toBe(500);
      expect(span.events.map((event) => event.name)).toContain('exception');
    } finally {
      await broken.close();
    }
  });
});
