import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

/**
 * Password-reset tokens follow the session precedent exactly: 32 random bytes,
 * base64url to the user, sha256 hex in the database.
 *
 * These two one-line functions are duplicated from `src/lib/session.ts` rather
 * than imported, because those names describe sessions and that file is a
 * CODEOWNERS-protected credential module. If a third token type appears, the
 * pair gets lifted into a shared module then — not now.
 */

/** Opaque, high-entropy token handed to the user in an email. 43 chars. */
export function generateResetToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Only the hash is persisted, so a database leak does not yield live tokens. */
export function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 32 bytes of base64url is exactly 43 unpadded characters. */
export const ResetTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Malformed reset token');

export function resetTokenExpiry(ttlMinutes: number, now: Date = new Date()): Date {
  return new Date(now.getTime() + ttlMinutes * 60_000);
}
