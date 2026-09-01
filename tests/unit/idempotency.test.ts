import { describe, expect, it } from 'vitest';
import {
  IdempotencyKeySchema,
  canonicalJson,
  requestFingerprint,
} from '../../src/lib/idempotency.js';

describe('idempotency fingerprinting', () => {
  it('fingerprint is stable under key order', () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    expect(requestFingerprint('POST', '/api/todos', { a: 1, b: 2 })).toBe(
      requestFingerprint('POST', '/api/todos', { b: 2, a: 1 }),
    );
    expect(requestFingerprint('POST', '/api/todos', { title: 'one' })).not.toBe(
      requestFingerprint('POST', '/api/todos', { title: 'two' }),
    );
  });

  it('canonicalises nested objects and drops undefined', () => {
    expect(canonicalJson({ outer: { b: [1, { y: 2, x: 1 }], a: true } })).toBe(
      canonicalJson({ outer: { a: true, b: [1, { x: 1, y: 2 }] } }),
    );
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
    expect(canonicalJson(undefined)).toBe('null');
  });

  it('fingerprint differs when the method or the route differs', () => {
    const body = { title: 'same' };
    const post = requestFingerprint('POST', '/api/todos', body);
    expect(requestFingerprint('PUT', '/api/todos', body)).not.toBe(post);
    expect(requestFingerprint('POST', '/api/other', body)).not.toBe(post);
  });

  it('accepts keys of 16 to 255 safe characters and rejects the rest', () => {
    expect(IdempotencyKeySchema.safeParse('a'.repeat(16)).success).toBe(true);
    expect(IdempotencyKeySchema.safeParse('a'.repeat(255)).success).toBe(true);
    expect(IdempotencyKeySchema.safeParse('Ab9_-'.repeat(4)).success).toBe(true);

    expect(IdempotencyKeySchema.safeParse('a'.repeat(15)).success).toBe(false);
    expect(IdempotencyKeySchema.safeParse('a'.repeat(256)).success).toBe(false);
    expect(IdempotencyKeySchema.safeParse('a'.repeat(15) + '/').success).toBe(false);
    expect(IdempotencyKeySchema.safeParse('').success).toBe(false);
  });
});
