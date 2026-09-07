import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Pulls the credential out of an `Authorization: Bearer <token>` header. The
 * scheme is matched case-insensitively because RFC 6750 says it is
 * case-insensitive, and monitoring agents do not agree on the casing.
 */
export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
  return match?.[1];
}

/**
 * Constant-time comparison of a presented credential against the expected one.
 *
 * `timingSafeEqual` throws on a length mismatch, and a length-guarded early
 * return would leak the real token's length, so both sides are hashed to a
 * fixed 32 bytes first and the digests are compared. An empty expected token
 * never matches: "no token configured" must not become "any token works".
 */
export function bearerTokenMatches(presented: string | undefined, expected: string): boolean {
  if (!presented || !expected) return false;
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(presented), digest(expected));
}
