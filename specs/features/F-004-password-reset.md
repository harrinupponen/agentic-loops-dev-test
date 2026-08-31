# F-004 · Password reset via emailed single-use token

## Problem

A user who forgets their password is permanently locked out. There is no recovery
path, and support has no safe way to help them without handling credentials.

## Scope

**In scope**

- Request a reset by email address
- Consume a single-use, time-limited token to set a new password
- Invalidate all existing sessions when the password changes

**Out of scope**

- Choosing or operating an email provider beyond a single adapter interface
- Account recovery by any other channel (SMS, security questions, support)
- Rate limiting beyond the per-route limit (F-011 makes it distributed)
- Notifying the user of the change by email — that lands with F-005

## Design

<!-- PLANNER: fill this in. Do not start implementation until the issue carries
     the `spec-approved` label. Points that need an explicit decision:

     - Token format and storage. The session precedent is: 32 random bytes,
       base64url to the user, sha256 in the database. Follow it unless there is
       a reason not to.
     - Response on an unknown email. Returning 404 turns this endpoint into a
       user-enumeration oracle. State the chosen behaviour and why.
     - Token lifetime, and whether requesting a new token invalidates the old one.
     - Session invalidation: all sessions, or all except the current one?
     - Email delivery is I/O that can fail or hang. Where does it happen relative
       to the transaction, and what does the user see if it fails?
     - Whether the transport is stubbed behind an interface so integration tests
       never send real mail. -->

## Acceptance criteria

<!-- PLANNER: at minimum these, plus whatever the design implies. -->

- [ ] Requesting a reset for a known address creates exactly one usable token
- [ ] The response is identical for a known and an unknown address
- [ ] A valid token sets the new password and returns 204
- [ ] A token cannot be used twice
- [ ] An expired token is rejected with 400 and a distinct error code
- [ ] Changing the password invalidates every existing session for that user
- [ ] The raw token never appears in the database or in any log line
- [ ] The request endpoint is rate limited more tightly than the global default

## Test plan

| Layer | Cases |
| --- | --- |
| unit | token generation, hashing, expiry arithmetic |
| integration | full reset flow · replay · expiry · unknown email · session invalidation · rate limit |
| e2e | forgot password → reset → log in with the new password |
| load | not a hot path; no thresholds |

## Security considerations

This is the single most attacked endpoint in most applications. It is worth
being explicit: a weak token, a leaked token in a log, a missing single-use
check, or a timing difference between known and unknown addresses each turn it
into full account takeover. Tokens are credentials and must be treated exactly
like session tokens.

## Observability

Counter for issued, consumed, expired, and rejected tokens. A spike in issued
without a matching rise in consumed means either a delivery failure or an
enumeration attempt.

## Rollout

Additive tables and endpoints. Ship behind a flag if the email provider is not
yet configured in production.
