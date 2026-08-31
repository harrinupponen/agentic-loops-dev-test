import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'sid';

/** Opaque, high-entropy session token handed to the client. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Only the hash is persisted, so a database leak does not yield live sessions. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function constantTimeEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
