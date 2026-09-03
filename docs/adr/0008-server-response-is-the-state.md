# 8. The server's response is the browser's state

Date: 2026-09-03
Status: Accepted

## Context

ADR 0006 chose a web client with no framework and no bundler, on the grounds that
the product is "two forms and a list". F-006 shipped the two forms, which have no
state worth managing — a panel is visible or it is not. F-016 ships the list,
which is the first screen with a collection, a pagination cursor, and three write
actions that change what is on screen.

Every UI framework exists to answer one question: when the server's data changes,
what re-renders? Having declined the frameworks, this project has to answer it in
prose, once, rather than have each screen invent its own answer. The next screens
in the backlog — session management (F-009), search (F-013), restore (F-010) —
will copy whatever F-016 does.

The constraints are the same ones ADR 0006 recorded, plus two from the API:
every list endpoint is keyset-paginated with an opaque cursor (ADR 0002), and
every write returns the full, authoritative representation of the row it
affected (`201` and `200` return a `TodoView`; `DELETE` returns `204`).

## Decision

**The rendered list is an array of rows the server has returned, in server order.
Nothing is displayed that the server did not send.**

Three rules follow:

1. **A write updates exactly the row it affected, from that write's own
   response.** Create prepends the `201` body. Toggle replaces the row by id from
   the `200` body. Delete removes the row on `204`. No refetch follows a write.
2. **No optimistic updates.** Nothing appears, changes, or disappears before the
   server has confirmed it. A control that has sent a request is disabled until
   it settles, which doubles as the double-submit guard.
3. **No cache and no cross-tab synchronisation.** The pagination cursor is stored
   as the opaque string the server sent, never derived from a rendered row.
   Nothing persists across a page load; a reload re-reads page one.

## Alternatives rejected

**Re-read the list after every write.** The conventional answer, and the one the
F-016 stub originally carried. It costs a second round trip per toggle, and it
has a worse problem: re-reading means re-reading _page one_, so a user who has
pressed "Load more" twice and then ticks a checkbox watches sixty rows collapse
back to twenty. Refetching every loaded page instead is N requests and a
consistency puzzle when a row was created or deleted in between. The write's own
response is exactly as authoritative as a re-read of the same row, and free.

**Optimistic updates with rollback.** Makes the UI feel instant, and creates a
second source of truth that must be reconciled with the first. Rollback paths are
where the bugs live, and they are the hardest thing in a UI to test honestly. For
a request to the same origin, against a list of twenty short rows, the latency
being hidden is not worth the class of bug being bought.

**A small store or observable layer.** Perhaps forty lines: subscribe, notify,
re-render. It is a framework, written here, untested, with no ecosystem — and it
would be justified by screens that do not exist yet. ADR 0006 already rejected
the mature versions of this idea; a homemade one is strictly worse than either
choice.

**Persist the list or the cursor in `sessionStorage` for faster reloads.** It
would put user-authored text into browser storage that survives log out, for a
saving of one request against the same origin. F-006's rule that nothing goes
into `localStorage` or `sessionStorage` stands, and the reason it stands is
unchanged.

## Consequences

The client's state is three variables — the item array, the cursor, and the
pending create — and every screen after this one should be describable the same
way. There is no reconciliation code, no cache invalidation, and no rollback
path, so there is nothing to test in those categories because there is nothing
there.

The list is stale with respect to other tabs and other devices until the user
reloads. That is accepted: this is a single-user todo list with no collaboration
and no realtime requirement. If one is ever stated, it arrives with its own
transport and its own ADR, and this one is what it supersedes.

Because a write's response is applied directly, every unsafe request must remain
safe to retry — which is what makes the `Idempotency-Key` on create
(ADR 0005) load-bearing rather than decorative, and it is why the key is bound to
the body the user is trying to send.

The signal to revisit is the same one ADR 0006 named: rendering logic duplicated
across screens and state that has to be manually kept in step in more than one
place. Two screens sharing three list transforms is not that.
