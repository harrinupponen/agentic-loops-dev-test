import { describe, expect, it } from 'vitest';
import {
  constantTimeEquals,
  generateSessionToken,
  hashSessionToken,
  truncateUserAgent,
} from '../../src/lib/session.js';

describe('session tokens', () => {
  it('generates unique high-entropy tokens', () => {
    const tokens = new Set(Array.from({ length: 200 }, generateSessionToken));
    expect(tokens.size).toBe(200);
    for (const t of tokens) expect(t.length).toBeGreaterThanOrEqual(43);
  });

  it('hashes deterministically and irreversibly', () => {
    const token = generateSessionToken();
    expect(hashSessionToken(token)).toBe(hashSessionToken(token));
    expect(hashSessionToken(token)).not.toContain(token);
    expect(hashSessionToken(token)).toHaveLength(64);
  });

  it('compares in constant time without throwing on length mismatch', () => {
    expect(constantTimeEquals('abc', 'abc')).toBe(true);
    expect(constantTimeEquals('abc', 'abd')).toBe(false);
    expect(constantTimeEquals('abc', 'abcdef')).toBe(false);
  });
});

describe('truncateUserAgent', () => {
  it('reports an absent, empty, or whitespace-only header as null', () => {
    expect(truncateUserAgent(undefined)).toBeNull();
    expect(truncateUserAgent('')).toBeNull();
    expect(truncateUserAgent('   ')).toBeNull();
  });

  it('returns a trimmed short string unchanged', () => {
    expect(truncateUserAgent('  Mozilla/5.0 (X11)  ')).toBe('Mozilla/5.0 (X11)');
  });

  it('keeps a string of exactly 256 characters whole', () => {
    const exact = 'a'.repeat(256);
    expect(truncateUserAgent(exact)).toBe(exact);
    expect(truncateUserAgent(exact)).toHaveLength(256);
  });

  it('cuts anything longer to exactly 256 characters', () => {
    expect(truncateUserAgent('a'.repeat(1000))).toHaveLength(256);
    expect(truncateUserAgent('a'.repeat(1000))).toBe('a'.repeat(256));
  });

  it('never cuts a multi-byte character into a lone surrogate', () => {
    // 255 ASCII characters then an astral emoji: a naive slice(0, 256) would
    // keep the high surrogate and drop its pair, producing a string that is not
    // valid UTF-8 once serialised.
    const result = truncateUserAgent('a'.repeat(255) + '😀' + 'b'.repeat(100))!;
    expect(result).toBe('a'.repeat(255));
    // A lone surrogate survives JSON.stringify but not a UTF-8 round trip.
    expect(Buffer.from(result, 'utf8').toString('utf8')).toBe(result);
    expect(/[\uD800-\uDFFF]/.test(result)).toBe(false);
  });
});
