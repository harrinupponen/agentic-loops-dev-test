import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, metricsAuth, TEST_METRICS_TOKEN, type TestContext } from './helpers.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

/**
 * `/metrics` is served on the same port as the public API, and F-004's
 * `mail_messages_total{kind="password_reset",outcome="sent"}` only moves for a
 * real account — an unauthenticated scrape is a user-enumeration oracle.
 */
describe('metrics authentication', () => {
  it('serves the prometheus body for a correct token', async () => {
    const res = await ctx.app.inject({ url: '/metrics', headers: metricsAuth() });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('http_request_duration_seconds');
  });

  it('rejects a request with no Authorization header', async () => {
    const res = await ctx.app.inject({ url: '/metrics' });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('unauthorized');
    expect(res.json<{ requestId: string }>().requestId).toBeTruthy();
    expect(res.body).not.toContain('http_request_duration_seconds');
  });

  it('rejects a wrong token', async () => {
    const res = await ctx.app.inject({
      url: '/metrics',
      headers: metricsAuth('wrong-metrics-token-that-is-long-enough'),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('unauthorized');
    expect(res.body).not.toContain('http_request_duration_seconds');
  });

  it('rejects a token that is a prefix of the real one', async () => {
    const res = await ctx.app.inject({
      url: '/metrics',
      headers: metricsAuth(TEST_METRICS_TOKEN.slice(0, -1)),
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects the right token under the wrong scheme', async () => {
    const res = await ctx.app.inject({
      url: '/metrics',
      headers: { authorization: `Basic ${TEST_METRICS_TOKEN}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts a case-insensitive bearer scheme, as RFC 6750 requires', async () => {
    const res = await ctx.app.inject({
      url: '/metrics',
      headers: { authorization: `bearer ${TEST_METRICS_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('serves unauthenticated outside production when no token is configured', async () => {
    // The documented development default: loadConfig refuses to boot with an
    // unset METRICS_TOKEN under NODE_ENV=production, so this open path can only
    // ever exist on a developer machine or in the test suite.
    const open = await createTestContext({ METRICS_TOKEN: '' });
    try {
      const res = await open.app.inject({ url: '/metrics' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('http_request_duration_seconds');
    } finally {
      await open.close();
    }
  });
});
