import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  RecoveryTokenSchema,
  generateRecoveryToken,
  hashRecoveryToken,
  recoveryTokenExpiry,
} from '../../src/lib/recovery-token.js';

describe('recovery token generation and hashing', () => {
  it('returns 43 base64url characters', () => {
    const token = generateRecoveryToken();
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('differs across 1000 calls', () => {
    const draws = new Set(Array.from({ length: 1000 }, () => generateRecoveryToken()));
    expect(draws.size).toBe(1000);
  });

  it('hashes to sha256 of the input, stably', () => {
    // Known vector: sha256('token') — proves the digest is sha256 hex, not
    // some other encoding that happens to round-trip.
    expect(hashRecoveryToken('token')).toBe(createHash('sha256').update('token').digest('hex'));

    const token = generateRecoveryToken();
    expect(hashRecoveryToken(token)).toBe(hashRecoveryToken(token));
    expect(hashRecoveryToken(token)).toHaveLength(64);
    expect(hashRecoveryToken(token)).not.toBe(token);
  });

  it('accepts a well-formed token and rejects the near misses', () => {
    expect(RecoveryTokenSchema.safeParse(generateRecoveryToken()).success).toBe(true);
    expect(RecoveryTokenSchema.safeParse('a'.repeat(42)).success).toBe(false);
    expect(RecoveryTokenSchema.safeParse('a'.repeat(44)).success).toBe(false);
    // base64 (not url-safe) alphabet: these are the characters a mangled or
    // hand-rolled encoder would produce.
    expect(RecoveryTokenSchema.safeParse(`${'a'.repeat(42)}+`).success).toBe(false);
    expect(RecoveryTokenSchema.safeParse(`${'a'.repeat(42)}/`).success).toBe(false);
    expect(RecoveryTokenSchema.safeParse(`${'a'.repeat(42)}=`).success).toBe(false);
    expect(RecoveryTokenSchema.safeParse('').success).toBe(false);
  });

  it('computes the expiry from the configured TTL in minutes', () => {
    const now = new Date('2026-09-07T12:00:00.000Z');
    expect(recoveryTokenExpiry(30, now).toISOString()).toBe('2026-09-07T12:30:00.000Z');
    expect(recoveryTokenExpiry(1, now).toISOString()).toBe('2026-09-07T12:01:00.000Z');
    // Email verification passes EMAIL_VERIFICATION_TTL_HOURS * 60, so the same
    // helper serves both flows and there is no second arithmetic path.
    expect(recoveryTokenExpiry(24 * 60, now).toISOString()).toBe('2026-09-08T12:00:00.000Z');
  });
});
