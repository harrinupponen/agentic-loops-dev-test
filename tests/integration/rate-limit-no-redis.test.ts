import { describe, expect, it, vi } from 'vitest';

/**
 * Proves the claim ADR 0018 makes about merge day: with REDIS_URL empty, the
 * executed path is the one running in production today. Not "requests still
 * succeed" — the ioredis constructor is never reached, so no socket, no
 * handshake, and no custom store can exist. Mocked in its own file because a
 * mocked ioredis would be useless to the real-Redis cases next door.
 */
const constructed = vi.fn();

vi.mock('ioredis', () => ({
  default: class {
    constructor(...args: unknown[]) {
      constructed(args);
    }
  },
}));

const { createTestContext } = await import('./helpers.js');

describe('the limiter with no redis configured', () => {
  it('constructs no client and attempts no connection', async () => {
    const ctx = await createTestContext({ RATE_LIMIT_MAX: '1' });
    try {
      await ctx.app.inject({ url: '/api/todos' });
      const limited = await ctx.app.inject({ url: '/api/todos' });

      expect(limited.statusCode).toBe(429); // the local store is doing the work
      expect(ctx.app.redis).toBeNull();
      expect(constructed).not.toHaveBeenCalled();
    } finally {
      await ctx.close();
    }
  });
});
