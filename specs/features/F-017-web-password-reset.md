# F-017 · Web UI — password reset screens

> Status is tracked in `specs/features.yaml`, not here.

## Problem

F-004 builds the password-reset API but no browser can reach it. A user who
forgets their password still sees only a sign-in form with no way forward, so the
problem F-004 set out to solve — "permanently locked out" — is not actually solved
for a human being. F-006 anticipated this and put reset screens out of scope
because the API did not exist yet.

## Scope

**In scope**

- A "Forgot your password?" entry point on the signed-out panel
- A request screen that posts an address to `POST /api/auth/password-reset` and
  shows the same confirmation regardless of the outcome
- A reset screen that reads a token from the page URL and posts it, with the new
  password, to `POST /api/auth/password-reset/confirm`
- Surfacing `invalid_token`, `token_expired`, `validation_failed`, and `429`
- The browser end-to-end journey F-004 could not have: request → reset → sign in
  with the new password

**Out of scope**

- Any change to the F-004 endpoints or their responses
- Email templates, link formats for any client other than this one
- Authenticated password change

## Design

<!-- PLANNER: fill this in after F-004 has been reviewed, so this inherits
     whatever the human changed. Points that need an explicit decision:

     - Reaching a reset screen needs a URL, and F-004 deliberately added no
       APP_BASE_URL and no link format. Both are decided here, together.
     - ADR 0006 chose one page with no client-side router. A reset link is an
       inbound deep link, which is the first requirement that genuinely pushes
       against that. Do not add a catch-all HTML fallback without revisiting
       ADR 0006 explicitly — F-006's design calls that out as the one construct
       that can make an API path return HTML.
     - The token must never reach the server in a query string (F-004's design).
       It may be in the page URL; the page reads it and sends it in a POST body.
       Say what stops it leaking via Referer, and what clears it from history.
     - ADR 0009's cost lands here in copy: requesting twice invalidates the first
       link. The message a user sees when that happens is a design decision.
     - The e2e journey needs the raw token in a browser. Whatever mechanism is
       chosen must not be an HTTP route that returns a token — see ADR 0010. -->

## Acceptance criteria

<!-- PLANNER: at minimum these, plus whatever the design implies. -->

- [ ] The signed-out panel offers a way to start a reset
- [ ] The request screen shows an identical confirmation for a known and an
      unknown address
- [ ] A reset screen reached with a valid token sets the new password
- [ ] Expired, used, and malformed tokens each produce a distinct, actionable
      message
- [ ] The token never appears in a request URL sent to the server
- [ ] `web/` still contains no HTML-injection sink and the CSP is unchanged

## Test plan

| Layer       | Cases                                                              |
| ----------- | ------------------------------------------------------------------ |
| unit        |                                                                    |
| integration |                                                                    |
| e2e         | request → reset → sign in with the new password · expired · replay |
| load        |                                                                    |

## Security considerations

<!-- PLANNER: fill in. The token in a page URL is the whole story: history,
     Referer, shoulder-surfing, and any third-party asset on the page. -->

## Observability

<!-- PLANNER: fill in. -->

## Rollout

<!-- PLANNER: fill in. Note that F-004 ships with MAIL_TRANSPORT=drop in
     production, so these screens are unusable there until a real transport
     exists. Decide whether this feature waits for one. -->
