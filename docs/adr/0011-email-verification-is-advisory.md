# 11. Email verification is recorded, not enforced

Date: 2026-09-07
Status: Accepted

## Context

F-005 adds email verification: a token is mailed at signup, confirming it records
that the address is real. The open question is not how to issue the token — ADR
0009 settled that — but what the application should _do_ with the answer.

The obvious design gates something on it: unverified accounts cannot log in,
cannot create todos, or lose access after a grace period. That is what
verification is normally for, and ADR 0007 pushes in the same direction: a
security control should fail closed rather than sit inert.

Except the precondition for enforcing it is false here, and visibly so.
`MAIL_TRANSPORT=drop` is what staging and production actually run (ADR 0010), and
it is what they will keep running until a real provider exists. No verification
mail is delivered anywhere. Every account in production is unverified and has no
route to becoming verified.

So a gate would not fail closed on a rare misconfiguration. It would fail closed
on **every user, deterministically, on the deploy that shipped it**, including the
accounts that already exist. A control that denies 100% of legitimate traffic is
not a control; it is an outage with a security rationale.

The tempting middle ground — ship the gate behind `REQUIRE_VERIFIED_EMAIL=false` —
is worse than either end. It puts an authorization branch in the codebase that no
environment ever executes, so it is proven by nothing but its own unit test, and
it turns the most security-sensitive decision in the feature into a runtime
setting somebody can flip without review.

## Decision

**`users.email_verified_at` records a fact. Nothing in the application authorizes
on it.**

- Signup issues a token and mails it; confirming stamps `email_verified_at`.
- Login, session creation, todo access, and password reset behave identically for
  a verified and an unverified account. There is no branch to enforce, and no
  flag that would add one.
- The state is readable — `emailVerified` on the user view — so a client can
  prompt, and so the eventual enforcement feature has the data it needs already
  populated for existing accounts.
- Existing rows are **not** backfilled as verified. `NULL` is the truth: nobody
  proved control of those mailboxes. The column would be worthless the moment it
  contained a claim that was never established.

**When enforcement is wanted, it arrives as its own feature, with its own ADR, and
it carries a boot rule.** That rule is the ADR 0007-shaped part of this decision,
and it is stated now so the later feature inherits it: _a build that enforces
verification must refuse to start when the configured mail transport does not
deliver._ Enforcement and `MAIL_TRANSPORT=drop` are a lockout, and the process is
the only thing positioned to notice.

## Consequences

The feature ships with no user-visible effect in production, twice over: the mail
is not delivered, and nothing would change if it were. Its value until a transport
lands is that the plumbing exists, is tested, and starts accumulating verified
addresses the day mail begins flowing. That is a real cost and it is the reason
this ADR exists rather than a comment in a route file.

An unverified address remains fully usable, which means the application keeps
accepting signups from addresses nobody controls — typo'd, mistyped, or somebody
else's. Today that is already true, and the mitigation is unchanged: registration
does not disclose anything to the address holder beyond one mail, and nothing of
value is attached to an unverified account.

`email_verified_at` is a timestamp rather than a boolean, so the eventual
enforcement feature can express "verified before X" or a grace period without a
migration. Only the boolean is exposed over the API; the timestamp is an internal
fact, and shipping it would be one more piece of account metadata on the wire for
nobody's benefit.

The signal that this feature is inert is a metric, not a comment:
`mail_messages_total{kind="email_verification",transport="drop"}` climbing while
`email_verification_total{outcome="consumed"}` stays at zero is exactly what
"shipped dark" looks like, and it is the same shape ADR 0010 established for
password reset.
