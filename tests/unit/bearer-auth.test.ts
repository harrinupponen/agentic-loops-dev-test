import { describe, expect, it } from 'vitest';
import { bearerToken, bearerTokenMatches } from '../../src/lib/bearer-auth.js';

describe('bearerToken', () => {
  it('extracts the token', () => {
    expect(bearerToken('Bearer abc123')).toBe('abc123');
  });

  it('treats the scheme as case-insensitive', () => {
    expect(bearerToken('bearer abc123')).toBe('abc123');
    expect(bearerToken('BEARER abc123')).toBe('abc123');
  });

  it('rejects another scheme, an empty token, and a missing header', () => {
    expect(bearerToken('Basic abc123')).toBeUndefined();
    expect(bearerToken('Bearer ')).toBeUndefined();
    expect(bearerToken('abc123')).toBeUndefined();
    expect(bearerToken(undefined)).toBeUndefined();
  });
});

describe('bearerTokenMatches', () => {
  it('accepts an identical token', () => {
    expect(bearerTokenMatches('s3cret-token', 's3cret-token')).toBe(true);
  });

  it('rejects a different token of the same length', () => {
    expect(bearerTokenMatches('s3cret-tokeM', 's3cret-token')).toBe(false);
  });

  it('rejects tokens of different lengths without throwing', () => {
    expect(bearerTokenMatches('s3cret-toke', 's3cret-token')).toBe(false);
    expect(bearerTokenMatches('s3cret-token-and-more', 's3cret-token')).toBe(false);
    expect(bearerTokenMatches('', 's3cret-token')).toBe(false);
  });

  it('rejects a missing candidate', () => {
    expect(bearerTokenMatches(undefined, 's3cret-token')).toBe(false);
  });

  it('rejects everything when the expected token is empty', () => {
    expect(bearerTokenMatches('', '')).toBe(false);
    expect(bearerTokenMatches('anything', '')).toBe(false);
  });

  it('compares multi-byte tokens by bytes, not code units', () => {
    expect(bearerTokenMatches('tökén', 'tökén')).toBe(true);
    expect(bearerTokenMatches('token', 'tökén')).toBe(false);
  });
});
