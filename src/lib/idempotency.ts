import { createHash } from 'node:crypto';
import { z } from 'zod';

export const IDEMPOTENCY_HEADER = 'idempotency-key';

/**
 * Client-chosen, so it is validated before it is allowed anywhere near the
 * database: bounded length, no separators, no whitespace.
 */
export const IdempotencyKeySchema = z
  .string()
  .min(16)
  .max(255)
  .regex(/^[A-Za-z0-9_-]+$/, 'Idempotency-Key must match ^[A-Za-z0-9_-]+$');

/**
 * Deterministic JSON: object keys are sorted at every depth so `{a,b}` and
 * `{b,a}` produce the same fingerprint. Array order is meaningful and is kept.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
}

/**
 * Identifies "the same request" for a given key. Method and route are included
 * so a key can never replay one endpoint's response onto another.
 */
export function requestFingerprint(method: string, route: string, body: unknown): string {
  return createHash('sha256')
    .update(`${method}\n${route}\n${canonicalJson(body)}`)
    .digest('hex');
}
