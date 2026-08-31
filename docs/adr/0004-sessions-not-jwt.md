# 4. Opaque server-side sessions rather than JWTs

Date: 2026-08-29
Status: Accepted

## Context

Two common options for authenticating a browser client: a stateless JWT, or an
opaque token backed by a session row.

JWTs are attractive because they need no database lookup. The cost is that they
cannot be revoked. A stolen token stays valid until it expires, "log out
everywhere" becomes impossible, and a permissions change does not take effect
until the next refresh. The usual workarounds — short expiry plus refresh tokens,
or a revocation list — reintroduce the database lookup that motivated the JWT.

## Decision

Sessions are opaque: 32 random bytes, base64url-encoded, delivered in a signed
HttpOnly `SameSite=Lax` cookie. Only the SHA-256 hash is stored, so a database
leak yields no usable sessions. Every request resolves the session with one
indexed lookup.

CSRF is handled by `SameSite=Lax` plus an Origin check on state-changing methods.

## Consequences

One extra indexed query per authenticated request — negligible at this scale, and
it buys instant revocation, "log out everywhere" (F-009), and immediate effect
for permission changes.

Horizontal scaling is unaffected, since the session store is Postgres rather than
in-process memory.

If session lookups ever become a measured bottleneck, the fix is a short-TTL
cache in front of the lookup, not a switch to JWTs.
