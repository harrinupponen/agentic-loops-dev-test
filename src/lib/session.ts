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

/** Longest device string a session row will hold. */
const USER_AGENT_MAX = 256;

/**
 * Normalises the `User-Agent` header into what a session row stores: trimmed,
 * NULL when absent or blank, and never longer than 256 characters (the header
 * is attacker-controlled and otherwise unbounded).
 *
 * Cuts on a whole code point: slicing UTF-16 units at 256 can split a surrogate
 * pair and leave a lone surrogate, which is not encodable as UTF-8. Such a
 * string would be stored and then serialised into a response body, so the last
 * character is dropped rather than broken. No parsing into "Chrome on macOS" —
 * that is a signature database with a rot schedule (ADR 0015).
 */
export function truncateUserAgent(raw: string | undefined | null): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  if (trimmed.length <= USER_AGENT_MAX) return trimmed;

  const cut = trimmed.slice(0, USER_AGENT_MAX);
  const last = cut.charCodeAt(USER_AGENT_MAX - 1);
  // A high surrogate in the final position lost its pair to the slice.
  const orphaned = last >= 0xd800 && last <= 0xdbff;
  return orphaned ? cut.slice(0, -1) : cut;
}

export function constantTimeEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
