import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ResetTokenSchema,
  generateResetToken,
  hashResetToken,
  resetTokenExpiry,
} from '../../src/lib/reset-token.js';

describe('reset token generation and hashing', () => {
  it('returns 43 base64url characters', () => {
    const token = generateResetToken();
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('differs across 1000 calls', () => {
    const draws = new Set(Array.from({ length: 1000 }, () => generateResetToken()));
    expect(draws.size).toBe(1000);
  });

  it('hashes to sha256 of the input, stably', () => {
    // Known vector: sha256('token') — proves the digest is sha256 hex, not
    // some other encoding that happens to round-trip.
    expect(hashResetToken('token')).toBe(createHash('sha256').update('token').digest('hex'));

    const token = generateResetToken();
    expect(hashResetToken(token)).toBe(hashResetToken(token));
    expect(hashResetToken(token)).toHaveLength(64);
    expect(hashResetToken(token)).not.toBe(token);
  });

  it('accepts a well-formed token and rejects the near misses', () => {
    expect(ResetTokenSchema.safeParse(generateResetToken()).success).toBe(true);
    expect(ResetTokenSchema.safeParse('a'.repeat(42)).success).toBe(false);
    expect(ResetTokenSchema.safeParse('a'.repeat(44)).success).toBe(false);
    // base64 (not url-safe) alphabet: these are the characters a mangled or
    // hand-rolled encoder would produce.
    expect(ResetTokenSchema.safeParse(`${'a'.repeat(42)}+`).success).toBe(false);
    expect(ResetTokenSchema.safeParse(`${'a'.repeat(42)}/`).success).toBe(false);
    expect(ResetTokenSchema.safeParse(`${'a'.repeat(42)}=`).success).toBe(false);
    expect(ResetTokenSchema.safeParse('').success).toBe(false);
  });

  it('computes the expiry from the configured TTL in minutes', () => {
    const now = new Date('2026-09-07T12:00:00.000Z');
    expect(resetTokenExpiry(30, now).toISOString()).toBe('2026-09-07T12:30:00.000Z');
    expect(resetTokenExpiry(1, now).toISOString()).toBe('2026-09-07T12:01:00.000Z');
  });
});
