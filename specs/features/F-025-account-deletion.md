# F-025 · Account deletion (GDPR erasure)

> Status is tracked in `specs/features.yaml`, not here.

## Problem

A user cannot close their account. Every row this application holds about
them — the account record, their todos including the ones in F-010's trash, every
session, both recovery-token tables, and the 90-day audit trail F-014 retains —
stays until somebody runs SQL against production by hand. F-015 lets a user take a
copy of all of it and gives them no way to make it stop existing, which is one half
of the GDPR obligation shipped without the other: Art. 20 portability without
Art. 17 erasure. There is also no way for a user to free their email address, since
`users.email` is unique and nothing removes the row.

## Scope

**In scope**

- An authenticated endpoint that permanently deletes the caller's account and
  everything that references it
- Re-authentication with the account password before anything is destroyed
- Ending the caller's session and clearing the cookie as part of the operation
- A counter, and a decision about what (if anything) is recorded, given that the
  account's audit trail dies with the account

**Out of scope**

- Anything about the export. F-015 owns `GET /api/auth/export`; this feature must
  not change its shape.
- A browser surface — **unless this feature's plan decides otherwise.** F-015
  deliberately did not create a web backlog entry, because one account-settings
  screen serves both the download link and the delete button, and it is this
  feature's plan that should split it out and own the id.
- An admin or operator deletion path, or deletion of anyone but the caller.
- Bulk or scheduled deletion of dormant accounts.

## Design

<!-- PLANNER: fill this in after F-015 has been reviewed, so this inherits
     whatever the human changed. F-015's "Backlog split" left five notes that are
     notes and NOT decisions for you:

     - No new table and no soft-delete column are needed. Every table that
       references `users` does so with ON DELETE CASCADE, so one DELETE FROM users
       removes sessions, todos, idempotency_keys, both token tables and
       audit_events in one statement. F-014 made audit_events.user_id NOT NULL for
       exactly this. Verify that against src/db/schema.ts rather than trusting it.
     - A GRACE PERIOD CANNOT BE BUILT WITH THE MECHANISM THIS CODEBASE HAS. ADR
       0017's sweep is caller-scoped and runs on the request path of the account
       that produced the rows — and a deleted account makes no further requests,
       so nothing would ever sweep a deferred deletion. "Deleted, restorable for
       30 days" means a scheduler, which means superseding ADR 0017. Decide, and
       say which.
     - The account's audit trail dies with it, including any `account.deleted` row
       this feature would write. An audit action whose row is destroyed by the
       operation it records is not an audit action. Decide explicitly what is
       recorded instead — a counter has no retention window and no owner.
     - Deletion frees the email address for re-registration. Whether that is
       desirable, and whether anything should stop the same address signing up
       again immediately, is this feature's call.
     - It SHOULD require the password again. F-015 argued explicitly that export
       does not, because an export reaches nothing a stolen session does not
       already reach; deletion is the opposite case — it is irreversible and it
       destroys evidence. Make that argument here rather than inheriting it.

     Also decide: does deletion offer the export first, or refuse to run until one
     has been taken? F-015 ships first precisely so the answer can be "the user
     had the option". Do not build a coupling between the two endpoints without
     arguing for it. -->

### API changes

| Method | Path | Auth | Notes |
| ------ | ---- | ---- | ----- |

### Data model changes

<!-- PLANNER: state explicitly whether a migration ships. F-015's notes say none
     is needed because every foreign key already cascades — confirm that against
     src/db/schema.ts and say so, rather than leaving this blank. If a grace
     period is chosen, that IS a migration and an expand/contract plan, and note
     that issue #11's CREATE INDEX conflict is still live in the code
     (scripts/ci/migration-safety.mjs and src/db/migrate.ts) even though the issue
     is marked closed. -->

### Key decisions

<!-- Alternatives considered and why they were rejected. If a decision is
     architectural, add an ADR under docs/adr/ and link it here. -->

## Acceptance criteria

<!-- PLANNER: at minimum these, plus whatever the design implies. -->

- [ ] Deleting an account with the correct password removes the user row, their
      todos (live and soft-deleted), their sessions, their audit events and both
      token rows
- [ ] The wrong password deletes nothing and returns the same shape a failed
      sign-in does
- [ ] The caller's session cookie is cleared and the session no longer
      authenticates anything
- [ ] One account's deletion leaves another account's rows untouched
- [ ] Unauthenticated, the endpoint deletes nothing and returns `401`
- [ ] The deleted address can (or cannot — state which) be registered again

## Test plan

| Layer       | Cases |
| ----------- | ----- |
| unit        |       |
| integration |       |
| e2e         |       |
| load        |       |

## Security considerations

<!-- PLANNER: fill in. This is the only irreversible operation in the
     application. A stolen session cookie plus this endpoint destroys an account
     and its audit trail — the evidence of the theft included. Re-authentication,
     rate limiting, and what is left behind that says the deletion happened are
     the three things to argue. -->

## Observability

<!-- PLANNER: fill in. The account's own audit trail is gone, so a counter is the
     only durable record. Say what it is called, what its labels are, and what
     value is correct. -->

## Rollout

<!-- PLANNER: fill in. There is no rollback for a deleted row: if this ships
     broken at 2am, what does the damage look like and what stops it? -->
