# 24. An audit event is evidence, not a control

Date: 2026-09-14
Status: Accepted

## Context

F-014 writes a row whenever something security-relevant happens to an account:
registration, sign-in, a failed sign-in, a password reset requested or completed,
a session revoked. Those rows are written on the auth hot path, next to operations
that create sessions and change credentials.

That raises a question every audit log has to answer once, and answering it late
is expensive: **what happens when the audit write fails?**

The compliance answer is fail-closed. If the event cannot be recorded, the
operation does not happen. It is the right answer when an external regime requires
that no unlogged action ever occurred, and it is the wrong answer here for
reasons specific to this codebase.

Look at what fail-closed would mean in `POST /api/auth/login`. The password is
verified, `createSession` inserts a row, `setSessionCookie` puts a signed cookie on
the reply. If the audit insert then throws and we let it, the user receives a `500`
for an operation that already succeeded — there is a live session in the database,
and possibly a valid cookie already on the reply. To make fail-closed actually mean
something, the audit write would have to be inside the same transaction as the
state change. That is worse: `POST /api/auth/password-reset/confirm` would then
roll back a password change and a full session purge because a bookkeeping row
would not insert, and `POST /api/auth/login` would need a transaction it does not
currently have, wrapped around an argon2 verification.

The failure mode that creates is the one that matters: **an audit log able to undo
a security operation is a new way to attack the security operation.** Fill the
disk, break the table, and password resets stop working.

## Decision

An audit event is evidence about the past, never a participant in the present.

1. **The write is awaited, wrapped in `try`/`catch`, and never fails the request
   it describes.** A failure increments `audit_write_failures_total`, logs at
   `error` level with the action, and the user's operation returns exactly what it
   would have returned.
2. **The write happens after the operation's state change and outside its
   transaction.** Never inside `db.transaction(...)`, never before the work it
   describes has committed.
3. **Nothing in the application reads the audit log to make a decision.** It is
   not an input to rate limiting, lockout, authorization, or any branch anywhere.
   The only reader is the account's own `GET /api/auth/audit-events`.

Rule 3 is what makes rules 1 and 2 safe. A log nothing depends on cannot break
anything by being incomplete, which is precisely why it is allowed to be
incomplete.

## Consequences

**The trail can have holes, and no user will ever see one.** A database hiccup
between the operation and the insert loses an event silently, and so does a
process that commits a transaction and then dies. This is the cost, paid
deliberately, and it has exactly one mitigation: `audit_write_failures_total` is
the only counter in this application whose correct value is exactly zero. Any
non-zero value means the log is incomplete and every conclusion drawn from it
afterwards is unsound. It is the first thing F-019 should alert on.

Because of that, **"no event" never proves "nothing happened"**, and no screen,
support answer, or future feature may treat it as proof. F-024 inherits this as a
copy constraint.

The crash window in rule 2 is microseconds wide and cannot be closed without
adopting the transactional design this ADR rejects. It is accepted, not overlooked.

If this application ever acquires an external obligation of the form "no
unlogged action occurred" — a contract, a certification, a regulator — this ADR is
what has to change first, and superseding it is the intended path. The change is
not a flag: it is the write moving inside each operation's transaction, a
transaction added to the routes that lack one, and a decision about what a user
sees when their sign-in fails because a bookkeeping table is full.

Rejected alongside fail-closed: **fire-and-forget** (`void insert(...).catch()`),
the shape `src/routes/auth.ts` uses for outbound mail. It is cheaper on the hot
path and it is wrong here for a different reason than fail-closed is: a mail
failure is eventually visible to a human waiting for an email, while a dropped
audit row is visible to nobody, ever. Awaiting costs one round trip on a path that
has already paid for argon2, and it keeps the failure inside the request that
caused it, where the request id, the trace id and the log context still exist.
