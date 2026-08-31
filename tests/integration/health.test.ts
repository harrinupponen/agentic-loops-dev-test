import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

describe('health', () => {
  it('reports liveness without touching the database', async () => {
    const res = await ctx.app.inject({ url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string }>().status).toBe('ok');
  });

  it('reports readiness when the database answers', async () => {
    const res = await ctx.app.inject({ url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string }>().status).toBe('ready');
  });

  it('reports not ready once shutdown has begun', async () => {
    ctx.app.isShuttingDown = true;
    const res = await ctx.app.inject({ url: '/readyz' });
    ctx.app.isShuttingDown = false;
    expect(res.statusCode).toBe(503);
    expect(res.json<{ reason: string }>().reason).toBe('shutting_down');
  });

  it('exposes prometheus metrics', async () => {
    const res = await ctx.app.inject({ url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('http_request_duration_seconds');
  });
});
