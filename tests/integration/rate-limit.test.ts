import { describe, expect, it } from 'vitest';
import { createTestContext } from './helpers.js';

describe('rate limiting', () => {
  it('returns 429 with a well-formed body once the limit is exceeded', async () => {
    const ctx = await createTestContext({ RATE_LIMIT_MAX: '1', RATE_LIMIT_WINDOW: '1 minute' });
    try {
      const first = await ctx.app.inject({ url: '/api/todos' });
      expect(first.statusCode).toBe(401); // under the limit, reaches auth as normal

      const second = await ctx.app.inject({ url: '/api/todos' });
      expect(second.statusCode).toBe(429);
      expect(second.json<{ error: { code: string } }>().error.code).toBe('rate_limited');
    } finally {
      await ctx.close();
    }
  });
});
