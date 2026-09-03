# F-016 · Web UI — todo list screen

> Status is tracked in `specs/features.yaml`, not here.
>
> Split out of F-006 during planning: "auth screens and todo list" was ~900–1000
> hand-written lines across three test layers, past the ~500-line guidance in
> `.agents/planner.md`. F-006 builds the shell, static serving, and the auth
> screens; this feature fills the signed-in panel with the list. Design is
> deliberately left for a planning run **after F-006 has been reviewed**, so it
> inherits whatever the human changes about the shell.

## Problem

Once F-006 ships, a signed-in user sees their email address and a log-out button.
The todos they own — the entire product — remain reachable only through the JSON
API. Everything needed to show them exists: `GET /api/todos` with keyset
pagination and a completed filter, `POST`, `PATCH`, and `DELETE` from F-003, and
`Idempotency-Key` on create from F-007.

## Scope

**In scope**

- Render the signed-in user's todos, newest first, inside the F-006 shell
- Load more via `nextCursor`, using the existing keyset pagination — never an
  offset, and never "fetch everything"
- Create a todo, sending an `Idempotency-Key` so a double-submit or a retried
  request cannot produce a duplicate (F-007 exists precisely for this client)
- Toggle completion and delete a todo
- Empty state, loading state, per-action error state, all keyboard accessible
- Browser e2e for the create → complete → delete journey

**Out of scope**

- Any API change. Every endpoint this needs already exists.
- The completed filter that `GET /api/todos?completed=` supports. The list shows
  everything; a filter is a separate, stated requirement when someone states it.
- Editing a title in place, reordering, drag and drop, bulk actions, due dates,
  tags, search (F-013), undo/restore (F-010)
- Optimistic updates and local caching. A write's own response is applied to the
  row it affected and nothing else refetches — see
  `docs/adr/0008-server-response-is-the-state.md`. (The stub said "re-read after a
  write"; planning changed that, because re-reading means re-reading page one and
  would collapse a user who has pressed "Load more". The rejected alternative is
  recorded in the ADR.)
- Infinite scroll. An explicit "Load more" button is keyboard- and
  screen-reader-accessible and does not fight the browser's scroll restoration.

## Design

### API changes

**None.** No route is added, changed, or renamed; `openapi.json` is
byte-identical and `npm run openapi:check` stays green without touching it. This
feature is a client of the API exactly as F-003 and F-007 left it.

The browser calls four existing endpoints:

| Method | Path             | Auth    | Used for                        | Handled failures                                                         |
| ------ | ---------------- | ------- | ------------------------------- | ------------------------------------------------------------------------ |
| GET    | `/api/todos`     | session | first page and each "Load more" | `401` → signed-out · `429` → API message · other → generic + `requestId` |
| POST   | `/api/todos`     | session | create, with `Idempotency-Key`  | `400 validation_failed` · `409 idempotency_*` · `401` · `429`            |
| PATCH  | `/api/todos/:id` | session | toggle `completed`              | `404` → row is gone, drop it from the list · `401` · `429`               |
| DELETE | `/api/todos/:id` | session | delete                          | `404` → already deleted elsewhere, treated as success · `401` · `429`    |

Query string for the list is built by the client and is always
`?limit=20` on the first page and `?limit=20&cursor=<encodeURIComponent(nextCursor)>`
after that. `nextCursor` is treated as an **opaque string**: it is echoed back
exactly as the server serialised it and never parsed into a `Date`, never
recomputed from a rendered row. A cursor derived from the last rendered row would
break the moment a row is deleted; echoing the server's value cannot.

`401` from **any** of the four calls returns the whole page to the signed-out
state (the shell's existing `showSignedOut`) and clears the list. That is the
session-expiry path; without it a user with a dead cookie sees an error alert
forever.

### Data model changes

**None.** No table, column, index, migration, or backfill — therefore no
expand/contract plan to state, and no ordering constraint against any other
feature. This feature adds no persistent server state and no client-side storage:
nothing is written to `localStorage`, `sessionStorage`, or a readable cookie, per
F-006's rule. The only new state is module-scope variables in the browser tab.

No new configuration key. No new dependency, production or dev —
`package-lock.json` is unchanged, so this PR does not need the dependency
justification AGENTS.md requires.

### File layout

```
web/index.html          + the todo panel markup inside #todo-panel (F-006's placeholder)
web/styles.css          + list, row, and checkbox styles
web/src/api.ts          + optional `headers` on ApiRequest (~3 lines, for Idempotency-Key)
web/src/todos.ts        NEW — DOM-free: typed calls, list transforms, key lifecycle
web/src/todo-list.ts    NEW — the DOM: render, events, mount/unmount
web/src/main.ts         + mount on sign-in, unmount on sign-out, onUnauthorized wiring
tests/unit/todos-client.test.ts   NEW — todos.ts with a stubbed fetch, node env
tests/unit/web-source-safety.test.ts  + a check that every byId() id exists in index.html
e2e/web-todos.spec.ts   NEW — the create → complete → delete journey and three others
```

The DOM-free / DOM split is the same one ADR 0006 forced on `api.ts`: the unit
project runs in the node environment with no jsdom and no new dependency, so
everything unit-testable must not reference `document`. Everything that does is
proved in a real browser by Playwright.

`web/src/todos.ts` exports the four typed calls plus three pure list transforms
(`applyCreated`, `applyUpdated`, `applyRemoved`) and the create-key lifecycle.
`web/src/todo-list.ts` holds every `document` reference for the panel.

### Markup added inside `#todo-panel`

One create form, one list, one "Load more" button, one status line, one alert
region — all static in `index.html`, none of it generated:

```
<form id="todo-form" aria-label="Add todo">   label + input#todo-title (required, maxlength 500)
<p id="todo-status" role="status">            loading / empty state
<p id="todo-alert" class="alert" role="alert" aria-live="polite" tabindex="-1">
<ul id="todo-list">                           one <li> per todo, built with dom.ts helpers
<button id="todo-more" type="button" hidden>  Load more
```

Each `<li>` is a checkbox (`<input type="checkbox">` + `<label for>` carrying the
title as a **text node**), and a "Delete" button whose accessible name includes
the title so screen-reader users and Playwright can both tell two rows apart.
Titles reach the page only through `textContent`, via the existing `dom.ts`
helpers — the source scan in `tests/unit/web-source-safety.test.ts` already covers
every new file under `web/` with no change.

### Client behaviour

**Mount.** When the shell switches to the signed-in panel it calls
`mountTodoList()`, which shows "Loading your todos…" and fetches page one. Zero
items → "You have no todos yet." Non-empty → rows, newest first, in server order.

**Unmount.** `showSignedOut()` calls `unmountTodoList()`, which empties the list,
clears the cursor and the in-memory items, and clears the pending create key. A
second user signing in on the same browser can therefore never see the first
user's rows even for one frame. This is an acceptance criterion, not a nicety.

**Load more.** Visible only while `nextCursor !== null`. Disabled while a page is
in flight, so a double click cannot fetch the same page twice.

**Writes apply the server's own response to the affected row, and nothing else
refetches.** Create prepends the `201` body (which, by `createdAt desc`, is
exactly where a re-read would put it); toggle replaces the row from the `200`
body; delete removes the row on `204`. No optimistic update, no rollback path, no
cache, no polling. See **`docs/adr/0008-server-response-is-the-state.md`**.

**Toggle.** A checkbox flips natively on click, so the client disables it, sends
`PATCH { completed }`, and then re-sets `checked` from the server's response —
on success and on failure alike. The checkbox never stays in a state the server
has not confirmed.

**Create and `Idempotency-Key`.** The client holds one pending create as
`{ key, title }`:

- submit with no pending create → new key from `crypto.randomUUID()`
- retry after a failure with the **same** title → reuse the key, so a create the
  server actually committed before the connection dropped is replayed, not
  duplicated
- retry with a **different** title → new key. ADR 0005 calls reusing a key for a
  different body "a client bug" and answers it with `409`; binding the key to the
  title means an honest user who fixes a typo and resubmits can never trigger it
- `201` → clear the pending create, so the next todo gets a fresh key

`crypto.randomUUID()` is 36 characters of `[0-9a-f-]`, which satisfies
`IdempotencyKeySchema` (`min(16)`, `^[A-Za-z0-9_-]+$`). It requires a secure
context: production is HTTPS and development is `localhost`, both of which
qualify. There is no fallback, because a fallback would be a weaker key generator
that only ever runs in a configuration this project does not ship.

The title is `trim()`ed before it is sent, and an empty result submits nothing.
That keeps the idempotency fingerprint stable across a retry where the user
happened to add a trailing space, and it catches the whitespace-only title that
native `required` does not.

**Errors.** **One** alert region for the whole panel, reusing F-006's pattern and
its `showAlert` rules verbatim (`4xx` shows the API's message, `5xx` shows the
generic message plus `requestId`, focus moves to the region). The message names
the action that failed — "Could not delete that todo." — so a single region still
tells the user which action it was. Any successful action clears it.

**`apiFetch` gains one option.** `ApiRequest` grows `headers?: Record<string, string>`,
merged after the defaults so the caller wins. It is the only way to send
`Idempotency-Key` without a second fetch wrapper.

### Key decisions

**The rendered list is whatever the server last said about each row; there is no
client store and no refetch after a write.** ADR
**`docs/adr/0008-server-response-is-the-state.md`**. Rejected: re-reading page one
after every write (the stub's original wording) — it costs a second request per
toggle and, worse, collapses a user who has pressed "Load more" twice back to
twenty rows; rejected: optimistic updates with rollback, which is a second source
of truth and a reconciliation bug generator for a list this short.

**One alert region for the panel, not one per row.** Rejected: per-row
`role="alert"` regions. Several live regions in one list is a worse screen-reader
experience than one, and it multiplies the markup by the row count for an error
that is rare and already names its action.

**The `Idempotency-Key` is bound to the title and cleared on success.** Rejected:
one key per page load (a second create would `409` against the first),
and a fresh key per submit (which makes the header decorative — a retry after a
timeout would create a duplicate, which is the entire failure F-007 exists to
stop).

**The list shows every todo; no completed/all filter.** `GET /api/todos` supports
`?completed=`, and wiring it up is maybe thirty lines. Nobody has stated the
requirement. It stays out until someone does.

**An explicit "Load more" button.** Rejected: infinite scroll — it is
keyboard-hostile, needs an `IntersectionObserver`, and fights the browser's
scroll restoration on a page that has none of its own.

**No new server code, therefore no new ADR about delivery.** ADR 0006 (no
framework, no bundler, same origin) and ADR 0007 (fail-closed boot) both apply
unchanged and this feature does not revisit either. ADR 0006's stated signal to
revisit — duplicated rendering logic and manual state synchronisation across
several screens — is worth checking against this diff, and the answer today is
one screen with three list transforms, which is not it.

## Acceptance criteria

- [ ] Signing in loads and renders the account's todos, newest first, in the
      order the API returned them — `e2e: create, complete, delete a todo`
- [ ] A fresh account sees "You have no todos yet." and the empty state
      disappears after the first create — `e2e: a second account sees an empty list`
- [ ] Creating a todo puts it at the top of the list without a page reload, and
      it is still there after a reload — `e2e: create, complete, delete a todo`
- [ ] `POST /api/todos` from the browser carries an `Idempotency-Key` matching
      `^[A-Za-z0-9_-]+$` and at least 16 characters —
      `unit: create sends a well-formed idempotency key`
- [ ] A failed create retried with the same title reuses the same key; retried
      with a changed title uses a new one; a successful create clears it so the
      next create uses a new one — `unit: the create key is bound to the title`
- [ ] Toggling the checkbox persists: after a reload the box is still checked —
      `e2e: create, complete, delete a todo`
- [ ] A failed toggle leaves the checkbox showing the server's value, not the
      user's click — `unit: applyUpdated replaces the row from the response`
      plus `e2e` coverage of the success path
- [ ] Deleting removes the row without a reload and it stays gone after one —
      `e2e: create, complete, delete a todo`
- [ ] With 21 todos, the first load shows 20 rows and a "Load more" button;
      pressing it appends the 21st and hides the button —
      `e2e: load more fetches the next keyset page`
- [ ] The "Load more" request sends the server's `nextCursor` verbatim,
      percent-encoded, with `limit=20` and no `offset` —
      `unit: the list path echoes the opaque cursor`
- [ ] A `nextCursor` string exactly as the API serialises it is accepted back as
      `?cursor=` and returns the following page —
      `integration: a serialised nextCursor round-trips as a query parameter`
- [ ] A v4 UUID is accepted as an `Idempotency-Key` and replays —
      `integration: a UUID-shaped idempotency key is accepted`
- [ ] Logging out and signing in as a different account shows an empty list with
      none of the first account's titles —
      `e2e: a second account sees an empty list`
- [ ] With the session cookie cleared, acting on a todo returns the page to the
      sign-in form rather than showing an error —
      `e2e: an expired session returns to the sign-in form`
- [ ] `DELETE` returning `404` (the row is already gone) removes the row and
      shows no error — `unit: a 404 on delete is treated as already deleted`
- [ ] Every element id passed to `byId()` anywhere in `web/src` exists in
      `web/index.html` — `unit: the web client binds only to ids that exist`
- [ ] No file under `web/` contains an HTML-injection sink — the existing
      `unit: the web client contains no HTML-injection sinks` scan covers the new
      files with no change to it
- [ ] The whole todo journey produces no console errors and no CSP violation —
      `e2e: the todo journey logs no console errors`
- [ ] Every control is reachable and operable by keyboard, and every e2e selector
      is by role or label — enforced by the e2e specs using
      `getByRole` / `getByLabel` exclusively
- [ ] `du -sk dist` stays under the existing 2048 KiB CI budget — CI Tier 1
      already enforces it

## Test plan

| Layer       | Cases                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unit        | `tests/unit/todos-client.test.ts`, node env, stubbed `fetch`, same shape as `api-client.test.ts`: list path building (first page, cursor page, percent-encoding, no `offset` anywhere) · create sends a schema-valid `Idempotency-Key` · key lifecycle (reuse on same title, new on changed title, cleared on `201`) · `applyCreated` prepends, `applyUpdated` replaces by id, `applyRemoved` removes by id, all three no-op on an unknown id · toggle sends only `{ completed }` · `404` on delete resolves rather than throws · plus the id-binding scan added to `web-source-safety.test.ts`                                                                                                                                                                                                                                                      |
| integration | This feature adds **no server code**, so the integration layer's job is to pin the contract the client now depends on, not to re-test F-003. Two new cases: a `nextCursor` string, taken from a real response body, round-trips as `?cursor=` and returns the next page (`tests/integration/todos.test.ts`); a v4 UUID key is accepted and replays (`tests/integration/idempotency.test.ts`). **Happy path · validation failure · unauthenticated · other user's resource** for all four endpoints already exist and are unchanged — `todos.test.ts` `requires authentication for every endpoint`, `creates, reads, updates and deletes a todo`, `rejects an empty patch body` / `rejects an oversized title`, and `never leaks another user's todo`. The last one is the one that matters and it is already green; this feature must not weaken it. |
| e2e         | `e2e/web-todos.spec.ts` in Chromium, four specs: **create → complete → delete** with a reload after each step (the critical journey) · **load more** (21 todos seeded through the page's own session with `page.evaluate(fetch)`, then 20 rows + button → 21 rows + no button) · **a second account sees an empty list** (register A, create, log out, register B, expect the empty state and none of A's titles) · **an expired session returns to the sign-in form** (`context.clearCookies()`, then act). Console errors and CSP violations are asserted across the journey using F-006's existing allowance for the bootstrap `401`.                                                                                                                                                                                                             |
| load        | No new k6 scenario. `load/smoke.js` already drives `GET /api/todos?limit=20` under the `list` tag with the existing thresholds — the identical request this screen makes. What this feature changes is the mix, not the shape: one list request per page load and one small write per interaction. If `p95` on the `list` tag moves after launch, the cause is traffic volume, which the existing thresholds already measure.                                                                                                                                                                                                                                                                                                                                                                                                                        |

## Security considerations

**Cross-site scripting — this is the feature's real exposure.** Todo titles are
the first _user-authored_ string this application renders. Email addresses in
F-006 were validated and effectively self-owned; a title is 500 arbitrary
characters that the owner chose. Every existing defence applies unchanged and now
actually matters: titles reach the page only as text nodes via `dom.ts`; the
source scan forbids `innerHTML`, `insertAdjacentHTML`, `document.write`, and
`eval` in every file under `web/` including the two new ones; and the CSP carries
no `unsafe-inline` or `unsafe-eval`, so an injected `<script>` is inert even if
the first two fail. The title is also used to build the delete button's
accessible name — that is `textContent`/`aria-label` on a created element, never
an HTML string.

**Authorization.** No new endpoint and no new query. Every read and write is
already scoped by `userId` in the `WHERE` clause, and another user's row returns
`404`, not `403`. The client cannot widen this: it sends an id and the server
decides. The browser-side risk is the _residue_ one — a second user on a shared
browser seeing the first user's rows — which is why `unmountTodoList()` clearing
the list and the in-memory items on log out is an acceptance criterion with an
e2e test behind it.

**Session expiry.** A `401` on any todo action drops the panel and returns the
sign-in form, so a dead session cannot leave stale, previously-authorised data on
screen.

**PII in titles.** A todo title is free text and will contain personal data. It
is never logged (the server does not log request bodies, and the client logs
nothing at all), and it never appears in a URL — create is a `POST` body, and the
only query parameters this client sends are `limit` and `cursor`. So titles stay
out of access logs, proxy logs, and `Referer` headers. Anyone later adding a
search box (F-013) with a `?q=` parameter is undoing that property and should say
so out loud.

**Idempotency key hygiene.** Keys are random UUIDs, scoped per user server-side,
and carry no user data. A key is neither logged nor persisted in the browser, so
it cannot leak from `localStorage` or an error report. Reusing a key across
different bodies is the only abuse path and it already returns `409`.

**Rate limiting.** No change, and one thing to watch: the global limit is 100
requests/minute per IP, and this screen now spends it on human clicks — a page
load costs one list request and each toggle or delete costs one. A user clicking
quickly through a long list, or an office behind one NAT, can now see a `429`
that previously only scripts saw. The API's message ("Too many requests. Retry in
N seconds.") is shown verbatim. F-011 replaces this limiter; nothing here should
be tuned in anticipation of it.

**Denial of service.** `limit` is fixed at 20 by the client and capped at 100 by
the server's schema, so no request this screen makes can ask for an unbounded
page. Keyset pagination keeps every page `O(limit)` regardless of depth
(ADR 0002).

**CSRF.** Unchanged: same-origin `fetch`, `SameSite=Lax`, and the Origin
allowlist that F-006 made a boot requirement. This feature adds state-changing
calls (`POST`, `PATCH`, `DELETE`) from the browser for the first time, which is
precisely the traffic that posture was built for — a good reason to re-read
ADR 0007 while reviewing this.

## Observability

Everything below already exists; what changes is that these series start
describing human behaviour instead of scripts.

- `http_request_duration_seconds{route="/api/todos",method="GET"}` — after this
  ships, this is the page-load path. A rate that stays flat after a deploy while
  `route="/"` rises means the list is not loading for anyone: the panel mounted
  and the fetch never happened, or it failed before it left the browser.
- The `5xx` and `429` share on `route="/api/todos/:id"` for `PATCH` and `DELETE`
  is the "are per-row actions working" signal. These methods had close to no
  production traffic before this feature; a non-zero `429` share here means real
  users are being throttled mid-interaction, which is the thing to watch on day
  one.
- `idempotency_outcomes_total{outcome="stored"}` should rise roughly in step with
  `POST /api/todos` — that is the proof the browser is actually sending the
  header rather than silently omitting it.
- `idempotency_outcomes_total{outcome="conflict"}` **should stay at approximately
  zero.** ADR 0005 calls a key reused for a different body a client bug, and after
  this feature the client in question is this one. A rising `conflict` rate is a
  direct signal that the key-per-title lifecycle is broken, and it is the single
  most useful alarm this feature creates.
- `outcome="replayed"` being non-zero is retries being deduplicated — the feature
  working as designed, not a problem.
- The `401` share on `route="/api/todos"` becomes a session-expiry signal. A jump
  right after a deploy means sessions broke, the same way F-006 reads
  `/api/auth/me`.
- **No new server log line and no client-side telemetry.** There is no server
  change to log from, and browser error reporting routinely carries PII in URLs
  and form state — here that would mean todo titles. Deliberately absent, same as
  F-006.

## Rollout

**No feature flag.** The change is markup, CSS, and three browser modules inside
the image. Every endpoint is byte-identical, `openapi.json` is unchanged, and
there is no migration, backfill, or ordering constraint against any other
feature. A flag would gate a panel that in the previous revision simply says
"Your todos will appear here."

**No environment change.** `ALLOWED_ORIGINS` and `WEB_ROOT` are already set
everywhere by F-006, and this feature adds no configuration of its own. Nothing
must be done to staging or production before merging.

**Order.** One PR. Merge to `main` deploys to staging, where `deploy.yml` runs
the full Playwright suite — including this feature's four new specs — against
`STAGING_URL` before the production promotion gate. The critical journey is
therefore a real gate, not a formality.

**Rollback at 2am.** Redeploy the previous image. The API is untouched, so no API
client is affected either way and no data is at risk; the UI reverts to the
placeholder panel and the todos remain reachable through the API exactly as they
are today. There is nothing stateful to unwind, which makes this one of the
cheapest rollbacks in the backlog. If the list is broken but the API is fine,
nothing about the rollback is urgent.

**Diff budget.** Estimated ~460 hand-written lines: `web/src/todos.ts` (~110),
`web/src/todo-list.ts` (~120), `index.html` and `styles.css` (~65),
`main.ts` and `api.ts` edits (~20), unit tests (~85), two integration cases
(~30), e2e (~110 minus the shared helpers it reuses from `web-auth.spec.ts`).
Under the ~500 guidance, so no further split. If it runs over, cut the CSS polish
first and the "Load more" spec's seeding helper second — never a test, and never
the unmount-on-logout behaviour.
