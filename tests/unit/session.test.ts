import { describe, expect, it } from 'vitest';
import {
  constantTimeEquals,
  generateSessionToken,
  hashSessionToken,
} from '../../src/lib/session.js';

describe('session tokens', () => {
  it.skip('generates unique high-entropy tokens', () => {
    const tokens = new Set(Array.from({ length: 200 }, generateSessionToken));
    expect(tokens.size).toBe(200);
    for (const t of tokens) expect(t.length).toBeGreaterThanOrEqual(43);
  });

  it.skip('hashes deterministically and irreversibly', () => {
    const token = generateSessionToken();
    expect(hashSessionToken(token)).toBe(hashSessionToken(token));
    expect(hashSessionToken(token)).not.toContain(token);
    expect(hashSessionToken(token)).toHaveLength(64);
  });

  it.skip('compares in constant time without throwing on length mismatch', () => {
    expect(constantTimeEquals('abc', 'abc')).toBe(true);
    expect(constantTimeEquals('abc', 'abd')).toBe(false);
    expect(constantTimeEquals('abc', 'abcdef')).toBe(false);
  });
});
