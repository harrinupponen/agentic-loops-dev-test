import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

/**
 * Recovery tokens — password reset and email verification — follow the session
 * precedent exactly: 32 random bytes, base64url to the user, sha256 hex in the
 * database. See docs/adr/0009-single-use-recovery-tokens.md.
 *
 * This module exists because a third token type appeared, which is the
 * condition the former `reset-token.ts` named for lifting its duplicated
 * generate/hash pair into a shared module. `src/lib/session.ts` is deliberately
 * left out of it: a session token is a credential rather than a recovery token,
 * and that file is a CODEOWNERS-protected module F-009 is about to change.
 */

/** Opaque, high-entropy token handed to the user in an email. 43 chars. */
export function generateRecoveryToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Only the hash is persisted, so a database leak does not yield live tokens. */
export function hashRecoveryToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 32 bytes of base64url is exactly 43 unpadded characters. */
export const RecoveryTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, 'Malformed recovery token');

/** Minutes for both callers; email verification passes its TTL hours × 60. */
export function recoveryTokenExpiry(ttlMinutes: number, now: Date = new Date()): Date {
  return new Date(now.getTime() + ttlMinutes * 60_000);
}
