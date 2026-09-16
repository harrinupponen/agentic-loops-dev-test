# 28. A recovery link arrives in the fragment, and the page scrubs it

Date: 2026-09-16
Status: Accepted

## Context

F-004 issues a password reset token and F-017 has to put a screen in front of it.
That needs a URL a mail client can render as a link, which is the first inbound
deep link this application has ever had, and it collides with three decisions
already made.

**ADR 0006 chose one page and no client-side router**, and F-006 rejected a
catch-all HTML fallback by name: it is the one construct that can make an API path
start returning HTML. A reset link is exactly the requirement that usually
justifies a router.

**F-004 forbade the token reaching the server in a query string.** A
`GET /reset?token=…` puts a live credential into the access log of every proxy on
the path, into the browser's history and autocomplete, and into the `Referer`
header of anything the page subsequently loads. F-004's design states the
constraint and records that honouring it is the page's job.

**ADR 0009 made the token single-use and one-per-account.** Anything that consumes
a token by being _fetched_ — rather than by a deliberate `POST` — can be burned by
something that is not the user: a mail-provider link scanner, a corporate security
gateway that prefetches every URL in a message, or a browser's own prerender. The
user then clicks their link and is told it is invalid, with no way to tell why.

## Decision

**The token travels in the URL fragment of the existing page, the page reads it
into memory and removes it from the URL before the user can act, and it reaches
the server only in a `POST` body.**

1. **The link format is `<origin>/#reset=<43-character token>`.** No new route, no
   new path, no catch-all, no router. `GET /` already serves the shell; the
   fragment is not part of the request.
2. **A fragment is never sent to a server.** It is not in the request line, so it
   cannot appear in an access log, and it is stripped from `Referer` by every
   browser, so it cannot leak to a third party either. This is the property that a
   query string does not have and cannot be given.
3. **The page scrubs it immediately.** On load, the client parses
   `location.hash`, keeps the token in a module-scope variable, and calls
   `history.replaceState(null, '', location.pathname)` before rendering anything.
   The address bar, the history entry, any bookmark taken afterwards and any
   screenshot of the page all lack the token from that moment.
4. **Consuming the token requires a `POST` with a password in the body.** No
   `GET` anywhere in the flow changes state, so a link scanner, a prefetch or a
   prerender cannot burn a token — it loads a page and nothing else.
5. **The client validates the token's shape (`^[A-Za-z0-9_-]{43}$`) before
   sending anything.** A mangled link is refused in the browser rather than
   costing the server an argon2 hash, which `POST /api/auth/password-reset/confirm`
   performs _before_ it knows whether the token is valid (F-004's timing
   equalisation).

`history.replaceState` is the only history API call in the client. It is not
routing: no state is pushed, nothing is popped, and there is no `popstate`
listener anywhere. It is a scrubber, and ADR 0006's "no history API" is about
navigation, not about deleting a credential from the address bar.

## Consequences

The reset screen is reachable by a link from an email without a second HTML route,
without a catch-all, and without the token ever being written to a server log. The
CSP stays exactly as F-006 set it (`default-src 'self'`, no `unsafe-inline`), so
the only scripts that can read the fragment are this application's own — which is
the whole security argument for keeping a credential in the DOM at all, and the
reason this ADR would have to be revisited the moment any third-party script is
added to the page.

**A reload loses the token.** After the scrub the URL is plain `/`, so refreshing
the reset screen returns the user to the sign-in form with the form they were
filling in gone. This is a real cost, accepted deliberately: the alternative is
leaving a live credential in the address bar for as long as the tab is open, and
the user's link is still in their inbox. The same applies to the back button.

**The token is visible on screen for a moment before the scrub**, and it is in the
mail message for its whole 30-minute life. Shoulder-surfing and an attacker with
mailbox access are not addressed here and cannot be — mailbox possession _is_ the
authentication factor this flow is built on.

**The fragment mechanism generalises to the other recovery token** — F-005's email
verification has the same shape and will want `#verify=<token>` when it gets a
screen. Nothing for it is built here: this ADR records the pattern, and the one
line of parsing it would share is not worth abstracting before a second caller
exists.

**F-018 inherits a contract, not a choice.** Whatever mail transport ships must
compose exactly `<APP_BASE_URL>/#reset=<token>`; a link with the token anywhere
else in the URL lands on a page that ignores it. That is one line in a template
and it is stated in F-017 so it is not rediscovered by reading client source.

Rejected, in the order they are tempting:

- **`GET /reset?token=…`, a second HTML route.** The clearest URL and the one most
  applications use. It puts the token in the request line — access logs, proxy
  logs, `Referer` — which F-004 forbids, and it needs a second HTML route whose
  existence is the first half of the catch-all F-006 refused.
- **`/reset#<token>`, a second HTML route with the token still in the fragment.**
  Safe on the leak axis and slightly prettier in an email, but it buys a route for
  cosmetics and moves this application one step towards the router ADR 0006
  declined.
- **A one-time exchange endpoint: `GET /reset?t=…` sets a cookie and redirects to
  a clean URL.** Keeps the address bar clean _after_ the redirect, but the token
  is in the request line for the request that matters, and it invents a second
  credential (the cookie) with its own lifetime and scope.
- **Leaving the fragment in place and not scrubbing.** Simpler, and the leak
  surface is genuinely smaller than a query string. Rejected because the address
  bar is where a token is most likely to be photographed, screen-shared,
  copy-pasted into a support chat or synced to a browser profile on another
  device, and `replaceState` costs one line.
