# F-011 · Distributed rate limiting backed by Redis

> Status is tracked in `specs/features.yaml`, not here.

## Problem

The rate limiter counts requests in the memory of one process. `src/app.ts`
registers `@fastify/rate-limit` with its default `LocalStore`, so every instance
of the application enforces `RATE_LIMIT_MAX` and `AUTH_RATE_LIMIT_MAX`
independently against its own LRU. Two consequences, both invisible from inside
one process. An attacker spreading a credential-stuffing run across a horizontally
scaled deployment gets `AUTH_RATE_LIMIT_MAX × instances` login attempts per
minute instead of ten, and which instance they land on is the load balancer's
choice, not theirs to control — but also not ours to prevent. And every counter is
lost on restart, so a rolling deploy, a crash loop, or a scale-up hands the same
attacker a fresh budget at a moment they can observe from the outside. The tighter
the limit, the more the multiplier matters: the limits that exist specifically to
bound credential stuffing and password-reset mail (`10/min` and `5/hour`) are
exactly the ones that degrade fastest as instances are added.

## Scope

**In scope**

- A `REDIS_URL` configuration key and an ioredis client built from it, with
  boot-time validation in the ADR 0007 shape
- A custom `@fastify/rate-limit` store that counts in Redis and **falls back to a
  per-instance window when Redis is unreachable** — degraded, never unlimited,
  never a 500 (ADR 0019)
- Hashing the rate-limit identity (user id or IP) before it leaves the process, so
  the shared store holds no raw address or account id
- One counter, one boot log line, and an edge-triggered warn/info pair on the
  transition into and out of degraded mode
- A `redis` service in `docker-compose.yml` and a throwaway Redis in the
  integration global setup, matching how Postgres is already handled
- `docs/deployment-sevalla.md` and `.env.example` updates describing the variable
  and what an empty value means

**Out of scope**

- **Provisioning a Redis instance anywhere.** No managed database is created, no
  connection string is set, and `REDIS_URL` is empty in staging and production on
  the day this merges. See ADR 0018 and the backlog split below — this is F-022.
- **Changing any limit value.** `RATE_LIMIT_MAX`, `AUTH_RATE_LIMIT_MAX`,
  `PASSWORD_RESET_RATE_LIMIT_MAX`, and `RATE_LIMIT_WINDOW` keep their current
  defaults and their current per-route wiring. This feature changes where the
  counter lives, nothing about what it counts to.
- **The read-through cache (F-012).** It will want the same Redis and should reuse
  `src/lib/redis.ts`, but no cache, no serialisation format, and no invalidation
  logic is designed here.
- **Moving sessions, idempotency keys, or any other state into Redis.** Postgres
  remains the only durable store; ADR 0004 and F-007 are untouched.
- **Redis as a readiness dependency.** `/readyz` keeps checking Postgres and
  nothing else; see "Key decisions".
- **Cluster, Sentinel, replicas, failover, persistence tuning, or backups.** A
  rate-limit keyspace is disposable by construction. Topology is F-022's to pick,
  and this design works against a single node without knowing which.
- **`ban`, exponential backoff, per-user quotas, IP allowlists, or a 429 body
  change.** The response an over-limit client sees is byte-for-byte what it is
  today.
- **Any database migration, route, schema, or OpenAPI change.**

## Design

### API changes

None. No new route, no changed status code, no changed response body, no change
to the `x-ratelimit-*` headers `@fastify/rate-limit` already sets, and therefore
no `openapi.json` regeneration.

| Method | Path      | Auth      | Notes                                                                                                                                 |
| ------ | --------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| \*     | `/api/**` | unchanged | Identical 429 envelope (`{ error: { code: "rate_limited", ... }, requestId }`). Only the location of the counter changes.             |
| \*     | `/**`     | unchanged | `/healthz`, `/readyz`, `/`, and static assets keep `config: { rateLimit: false }` and never touch the store, Redis configured or not. |

### Configuration

Two new keys in `src/config.ts` and `.env.example`:

| Key                | Type   | Default | Meaning                                                                                                                   |
| ------------------ | ------ | ------- | ------------------------------------------------------------------------------------------------------------------------- |
| `REDIS_URL`        | string | `''`    | `redis://` or `rediss://` connection URL. **Empty = the limiter keeps today's per-instance store**, and no client exists. |
| `REDIS_TIMEOUT_MS` | number | `50`    | Per-command budget. A command that does not answer inside it is a store failure and the request falls back locally.       |

`REDIS_URL` is the standard name and is what F-012 will read too. Empty is the
value in every deployed environment on merge day, exactly as
`OTEL_EXPORTER_OTLP_ENDPOINT` is (ADR 0012).

**Boot rules, in `loadConfig`, ADR 0007 shape — the process refuses to start:**

1. `REDIS_URL` is set but is not a parseable absolute URL. A typo here means the
   limiter silently runs local forever, which is the failure this feature exists
   to remove.
2. `REDIS_URL` is set with a scheme other than `redis:` or `rediss:`. A
   `postgres://` URL pasted into the wrong box must not produce a connection
   attempt in a retry loop.

`REDIS_TIMEOUT_MS` outside `1..1000` is a zod bound, like every other knob.

**There is deliberately no rule that requires `REDIS_URL` in production.** That is
the one place this design departs from ADR 0007, and it is argued in ADR 0018: an
empty value does not remove a security control here, it leaves the control exactly
as it is today. ADR 0007's trigger is a control that disappears silently; this one
does not disappear, and the boot log line below says which store is live.

### Data model changes

**None in Postgres.** No migration, no column, no index, no backfill, so there is
no expand/contract plan to state and nothing in the database to undo on rollback.
This is the second feature since F-001 with no `drizzle/` file.

The one new piece of state is the Redis keyspace, which is worth writing down
because nothing else in the repo describes it:

| Property     | Value                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Key          | `rl:{METHOD}{/route/template}-{hash}` for a route with its own limit, `rl:{hash}` for the global limit                                |
| `hash`       | `HMAC-SHA256(COOKIE_SECRET, userId ?? ip)`, hex, truncated to 32 characters — never the raw id or address                             |
| Value        | An integer counter, set by `INCR` inside the plugin's own Lua script                                                                  |
| TTL          | `PEXPIRE` to the route's window: 1 minute, or 1 hour for password reset. Nothing survives longer than its window.                     |
| Durability   | None required. `--appendonly no` is fine; a flushed or restarted Redis resets counters, which is precisely today's restart behaviour. |
| Growth bound | One key per active identity per window. TTLs are the only eviction this needs; `maxmemory-policy volatile-lru` is a belt.             |

The expand/contract analogue is trivial and worth saying plainly: turning the
shared store on is setting one variable, turning it off is unsetting it, and
neither direction reads or writes anything that has to be migrated.

### Files

| File                          | Change                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `src/lib/redis.ts`            | **new.** `createRedis(config)` → `Redis \| null`. Connection options, no application logic. F-012 reuses this.     |
| `src/lib/rate-limit-store.ts` | **new.** The store: Redis primary, local fallback, hashed keys, degrade/recover transitions, the counter.          |
| `src/app.ts`                  | Build the client, pass `store` only when one exists, close it in an `onClose` hook. ~15 lines.                     |
| `src/plugins/metrics.ts`      | Register `rate_limit_store_operations_total` and log the boot line, next to the existing tracing/metrics lines.    |
| `src/config.ts`               | The two keys and the two boot rules.                                                                               |
| `.env.example`                | Both keys with the comment explaining what empty means.                                                            |
| `docker-compose.yml`          | A `redis:7-alpine` service with a healthcheck, matching the `db` service's shape.                                  |
| `tests/integration/`          | `global-setup.ts` starts a throwaway Redis when `REDIS_URL` is unset; `rate-limit.test.ts` grows the shared cases. |
| `docs/deployment-sevalla.md`  | `REDIS_URL` in the environment table, and the note that nothing is provisioned yet.                                |

No workflow file changes. No `Dockerfile` change. No `package-lock.json` change
beyond the single dependency below.

### How the counter gets shared

**`src/lib/redis.ts`** builds one ioredis client per process, or returns `null`
when `REDIS_URL` is empty. The options are the whole design of the failure
behaviour, so they are listed explicitly:

| Option                 | Value               | Why                                                                                                            |
| ---------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------- |
| `enableOfflineQueue`   | `false`             | While disconnected, commands reject **immediately** instead of queuing. This is the circuit breaker, for free. |
| `maxRetriesPerRequest` | `1`                 | One retry, then fail. A request must never wait on a reconnect.                                                |
| `commandTimeout`       | `REDIS_TIMEOUT_MS`  | A slow Redis is a failed Redis as far as a request is concerned.                                               |
| `connectTimeout`       | `1000`              | Reconnects happen in the background and never block a request.                                                 |
| `lazyConnect`          | `true`              | `buildApp` returns even if Redis is down; the first request degrades and the client keeps reconnecting.        |
| `retryStrategy`        | capped backoff, 2 s | Reconnect forever, cheaply. There is no "give up" state.                                                       |
| `keyPrefix`            | `rl:`               | One namespace, so F-012 can take another without collision.                                                    |

An `error` event handler logs at `warn` with `{ host, port }` and **never the
URL**, which contains the password.

**`src/lib/rate-limit-store.ts`** implements `FastifyRateLimitStore` —
`incr(key, cb, timeWindow, max)` and `child(routeOptions)` — and is passed to the
plugin as `store`. Per request:

1. Hash the key. The plugin hands us `request.user?.id ?? request.ip` from the
   existing `keyGenerator`; we HMAC it before it is used as a Redis key.
2. Try Redis: the same `INCR` + `PEXPIRE` Lua script `@fastify/rate-limit`'s own
   `RedisStore` uses, registered once with `defineCommand`. One round trip, atomic,
   no read-modify-write race between instances.
3. On success, `rate_limit_store_operations_total{store="redis",outcome="ok"}`, and
   if the previous call had failed, log `info` "rate limiter recovered".
4. On error or timeout, `{store="redis",outcome="error"}`, log `warn` **once per
   transition** (not per request — a Redis outage must not become a log flood),
   and count the request in the local window instead, returning that result.

`child(routeOptions)` returns a new store sharing the same client with the key
prefix the plugin's own `RedisStore` uses (`${method}${url}-`), which is what keeps
`POST /api/auth/login`'s tighter limit from sharing a bucket with the global one.
The fallback window is a bounded `Map` with the same semantics as the plugin's
`LocalStore` — counter plus window start, reset when the window has elapsed —
cleared wholesale if it exceeds 10 000 entries, since it only fills during an
outage and a fallback limiter must not become the memory leak that ends the
process.

**`src/app.ts`** changes shape only when a client exists:

```
const redis = createRedis(config);              // null when REDIS_URL is empty
await app.register(rateLimit, {
  ...everything exactly as today...,
  ...(redis ? { store: makeRateLimitStore(redis, config, metrics) } : {}),
});
if (redis) app.addHook('onClose', async () => { await redis.quit(); });
```

With `REDIS_URL` empty, `store` is not passed at all: the plugin constructs its own
`LocalStore` and the executed code path is byte-for-byte today's. That is what makes
merge day a genuine no-op rather than a re-implementation of the current behaviour.

`src/index.ts` needs no change — `app.close()` already runs `onClose` hooks before
the pool is drained.

### Key decisions

Two ADRs: **`docs/adr/0018-a-shared-limiter-needs-a-store-nobody-has-bought.md`**
(what ships and what does not) and
**`docs/adr/0019-a-rate-limiter-degrades-rather-than-fails.md`** (what happens when
Redis is unreachable).

**The capability ships; the Redis does not.** Checked rather than assumed:
`npx sevalla databases create --help` lists `redis` and `valkey` among its types,
so provisioning is genuinely one command or one dashboard click — the platform is
not the obstacle. What is an obstacle is that this project's own convention is a
separate store per environment (two Postgres instances today, `agentic-todo-db` and
`agentic-todo-db-prod`, deliberately not shared), so honouring it means **two new
always-on billed services**, two credentials in two environments, a plan size, and
a region. Three options:

- _Provision Redis inside this PR._ Rejected. It commits a human's money and picks
  a retention and residency posture inside a pull request about a counter, and an
  agent holds no live Sevalla token in this session anyway (`sevalla databases list`
  returns `401`). Identical in shape to the vendor decision ADR 0012 refused.
- _Require it: refuse to boot in production without `REDIS_URL`._ Rejected, and
  this is the closest call in the feature. It is the ADR 0007 instinct, but ADR 0007
  fires when an unset variable makes a control **vanish**. Here an unset variable
  leaves the existing limiter running at exactly today's effectiveness. Requiring it
  would make the app undeployable until somebody pays, which converts a nice-to-have
  into an outage, and it would have to be merged in a specific order relative to a
  purchase — the worst kind of coupling to put on a Friday.
- **Chosen: the store is selected by `REDIS_URL`, empty everywhere.** The honest
  cost, said plainly: **this feature has no effect in production on the day it
  merges.** That is the fourth time this project has shipped something dark (ADR
  0010's transport, ADR 0011's verification, ADR 0012's traces), and it deserves the
  same scepticism each time. What it buys is that the decision left to a human is a
  purchasing decision, not an engineering one, and enabling it is one variable and a
  restart.

**Redis unreachable means degraded, not denied, and not 500.** Verified in the
installed version rather than assumed: `@fastify/rate-limit@10.3.0` defaults
`skipOnError` to **`false`** (`index.js:108`), so the obvious wiring — pass
`redis: client` and move on — turns a two-second Redis blip into a 500 on **every**
request, including `POST /api/auth/login`. That is fail-closed by accident, and it
is a self-inflicted outage triggered by a dependency an attacker can target. The
other stock option, `skipOnError: true`, is blind fail-open: knock Redis over and
the limiter stops existing, which makes the cache the softest path to unlimited
login attempts. Neither is acceptable, which is the entire reason this feature owns
a store class instead of five lines of options. The chosen behaviour keeps the
per-instance limiter as the floor: an attacker who takes Redis down buys themselves
`max × instances`, which is the situation we are in today, not `max × ∞`. Argued in
full in ADR 0019.

**Redis is not added to `/readyz`.** It follows from the above: if a store outage
is survivable, an instance suffering one is still serving correct responses, and
failing readiness would take every instance out of rotation simultaneously and turn
a degraded limiter into a total outage. The degraded state is reported through a
metric and a log line, which is where a non-fatal condition belongs.

**The identity is hashed before it leaves the process.** Keys are
`HMAC-SHA256(COOKIE_SECRET, userId ?? ip)`. Without it, Redis becomes a second
datastore holding raw client IP addresses and user ids — a new location for personal
data, with its own access control and its own retention story, for no benefit, since
nothing ever reads a key back by name. Unsalted SHA-256 would be reversible by
brute force over the IPv4 space in seconds, so the hash is keyed. `COOKIE_SECRET` is
already required, already ≥32 characters, and already per-environment, which means
staging and production cannot collide even if they are ever pointed at one Redis by
mistake. The cost is that "which IP is being limited" is no longer answerable from
Redis — it stays answerable from the access log, where `remoteAddress` already is.

**One new runtime dependency: `ioredis`.** It is the client `@fastify/rate-limit`
is written against (its own `RedisStore` calls `defineCommand`), it is what F-012
will reuse, and it is the only client whose disconnected-behaviour knobs make the
fail-fast design above possible without a hand-rolled circuit breaker. Rejected
`node-redis` (would need its own script handling and a breaker) and rejected writing
a breaker by hand (`enableOfflineQueue: false` is the same thing, tested by someone
else). **Zero new devDependencies**: the integration suite starts Redis with
`GenericContainer` from the `testcontainers` package that is already installed.

**No workflow file is touched.** `tests/integration/global-setup.ts` already starts
a throwaway Postgres when `DATABASE_URL` is unset; Redis follows the identical
pattern, so CI needs no service container, no new secret, and no edit to a
CODEOWNERS-protected file. The e2e and load jobs leave `REDIS_URL` unset and run the
local store, unchanged.

**A trap that would otherwise eat an afternoon after F-022.** The
`agentic-todo-staging` Sevalla app has `RATE_LIMIT_MAX=100000` and
`AUTH_RATE_LIMIT_MAX=100000` set as environment variables — added deliberately so
the Playwright suite, which registers many real accounts, can run against live
staging. Anyone who provisions Redis and then "verifies distributed limiting on
staging" will see nothing whatsoever, because the limit is effectively infinite
there. F-022 owns reconciling this; it is called out in the rollout section and in
the issue body rather than left to be rediscovered.

### Backlog split

**F-022 "Provision shared Redis and enable the distributed limiter" is added to the
backlog**, deps `[F-011]`, tags `[infra, security]`. It owns: redis vs valkey, the
plan size and the bill, one instance per environment or one shared, the connection
strings in both Sevalla apps, `maxmemory-policy`, reconciling the staging limit
overrides above, and watching `rate_limit_store_operations_total` for the first hour
after the switch.

The cut is at the purchase for the same reason F-008/F-019 cut at the datasource:
everything before it is engineering that can be proven locally and in CI, and
everything after it is money, residency, and credentials. **F-012's dependency list
is left unchanged and this is flagged rather than decided** — a read-through cache
with no Redis is as dark as this limiter is, so the human may well want F-012 to
depend on F-022 too. Rewiring another feature's deps inside this PR would be exactly
the silent scope creep this repo has a review gate for.

## Acceptance criteria

- [ ] With `REDIS_URL` unset, no Redis client is constructed, the plugin's own
      `LocalStore` is used, and the existing rate-limit behaviour is unchanged —
      `integration: no redis client is built when REDIS_URL is empty` plus the
      existing `rate-limit.test.ts` case passing untouched
- [ ] With `REDIS_URL` set, two independently built app instances sharing one Redis
      enforce **one** combined limit: with `RATE_LIMIT_MAX=2`, request 1 to app A and
      request 2 to app B succeed and request 3 to app A returns 429 —
      `integration: the limit is shared across instances`
- [ ] That 429 has the same body and `error.code` as the local-store 429, asserted
      against the same expectation object —
      `integration: the redis-backed 429 envelope is unchanged`
- [ ] A route with its own limit does not share a bucket with the global limit:
      exhausting `POST /api/auth/login` at `AUTH_RATE_LIMIT_MAX` leaves
      `GET /api/todos` still serving — `integration: per-route limits keep separate keys`
- [ ] No key in Redis contains a raw IP address or a user id; the keys present after
      a limited request match `rl:*` and contain the HMAC, and the same identity
      produces the same key across two processes with the same `COOKIE_SECRET` and a
      different one under a different secret — `unit: rate-limit-store.test.ts` +
      `integration: redis keys carry no raw identity`
- [ ] When Redis is stopped mid-run, requests keep being served — no 500, no
      `skipOnError` throw — and the limit is still enforced per instance: with
      `RATE_LIMIT_MAX=1`, the second request after the outage begins is still a 429 —
      `integration: a redis outage degrades to a local limit rather than failing`
- [ ] A request during that outage completes within `REDIS_TIMEOUT_MS + 50 ms`, so a
      hung Redis cannot become request latency —
      `integration: a timing-out store does not stall the request`
- [ ] The transition into degraded mode logs exactly **one** `warn` for a burst of
      requests, and recovery logs exactly one `info` —
      `unit: degrade and recover are edge-triggered`
- [ ] `rate_limit_store_operations_total{store="redis",outcome="ok"}` advances on a
      healthy limited request and `{outcome="error"}` advances during the outage,
      both readable from `/metrics` — `integration: the store counter reflects redis health`
- [ ] `loadConfig` throws for an unparseable `REDIS_URL`, for a `postgres://` scheme,
      and for `REDIS_TIMEOUT_MS=0`; accepts an empty `REDIS_URL` under
      `NODE_ENV=production` — `unit: config.test.ts`, one case each
- [ ] Neither the connection URL nor its password appears in any log line at any
      level, including the connection-error path —
      `integration: the redis url is never logged`
- [ ] The boot log line states which store is live —
      `{ rateLimitStore: 'redis' | 'memory' }` — `integration: boot reports the store`
- [ ] `app.close()` disconnects the client; the integration suite finishes with no
      open handle — `integration: the client is closed with the app`
- [ ] `make ci` passes with no new environment variable set anywhere in CI, and
      `openapi.json` is unchanged

## Test plan

| Layer       | Cases                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unit        | `tests/unit/rate-limit-store.test.ts` against a fake client: key hashing is stable, keyed, contains no raw input, and changes with the secret · `child()` namespaces by method and route · a rejecting client falls back and still counts · the fallback window increments, expires, and resets · the fallback map is bounded · degrade/recover log exactly once per transition · the counter is incremented with the right labels. `tests/unit/config.test.ts`: the two boot rules, accept and reject, plus empty-in-production accepted.                                                                                                                                                                                                                                                                                                         |
| integration | `tests/integration/rate-limit.test.ts`, against a real Redis from `GenericContainer('redis:7-alpine')` started in `global-setup.ts`: **happy path** (limit shared across two `buildApp` instances) · **validation failure** is not applicable — the limiter runs before body validation, so the case asserted instead is that a 400 still consumes budget · **unauthenticated** (an anonymous request is keyed by IP, an authenticated one by user id, and the two do not share a bucket) · **other user's resource** is not applicable; the analogue asserted is that two users never share a key · outage: `container.stop()` mid-test, assert degraded limiting, no 5xx, bounded latency, counter labels, one warn · recovery after restart · keys inspected with `KEYS rl:*` for raw identities · no URL in logs · client closed with the app. |
| e2e         | None, deliberately. There is no browser surface and no user-visible change; Playwright runs against `STAGING_URL`, where `REDIS_URL` is empty by construction and the limits are overridden to 100 000 anyway. The proof that matters is cross-instance agreement, which one browser cannot observe — the two-instance integration test is that test.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| load        | `k6 run load/smoke.js` twice against a local server, `REDIS_URL` unset then set, both under the existing `p(95)<300ms` threshold. Budget: p95 within 10 %, since the change adds one local Redis round trip per request. Recorded in the PR body, not a CI gate — CI has no Redis on the load job and this feature does not add one. A regression beyond that budget means `REDIS_TIMEOUT_MS` is the first knob and connection reuse the first suspect.                                                                                                                                                                                                                                                                                                                                                                                            |

## Security considerations

**The control being changed is the one that bounds credential stuffing**, so the
failure modes matter more than the happy path. Enumerated:

- **Attacker knocks Redis over to defeat the limiter.** The realistic attack on any
  shared limiter, and the reason ADR 0019 exists. The floor is the per-instance
  window: they buy `max × instances`, today's posture, not unlimited. Combined with
  the fact that Redis is reachable only on Sevalla's internal network, the attacker
  who can do this already has better options.
- **Attacker knocks Redis over to cause an outage.** Prevented by construction —
  a store error is never surfaced to the client, never a 5xx, never readiness. This
  is the failure `skipOnError: false` would have handed them for free.
- **Latency amplification.** A hung Redis is capped at `REDIS_TIMEOUT_MS` (50 ms)
  per request, once, with no offline queue and no retry storm, and the degraded
  path is pure local memory.
- **Key-space flooding.** One key per identity per window, each with a TTL no longer
  than an hour. An attacker rotating IPs fills memory no faster than they would fill
  the existing LRU, and `volatile-lru` bounds the tail. The local fallback map is
  explicitly bounded and cleared.
- **The shared store as a cross-instance oracle.** Nothing reads a key back and no
  count is returned to a client beyond the `x-ratelimit-remaining` header that
  already exists, so the shared store adds no new information channel.

**PII.** Redis holds no raw IP address and no user id — only a keyed HMAC that
expires with the window. This is a deliberate step beyond "Redis is internal": an
IP address is personal data under the same reading that makes an email address one,
and the repo's logging rules already forbid the careless version. Nothing in the
limiter path touches `users`, `sessions`, or any message body.

**Credentials.** `REDIS_URL` contains a password. It is never logged, never in an
error message, never on a span, and never in a response; the connection-error path
logs `{ host, port }` only, and an acceptance criterion asserts it. It joins
`COOKIE_SECRET` and `METRICS_TOKEN` in `.env.example` with an empty default and a
comment. No TLS requirement is imposed for a `redis://` URL, deliberately and
symmetrically with `DATABASE_URL`: the intended connection is in-cluster and
private, the same reasoning `docs/deployment-sevalla.md` already records for
Postgres. `rediss://` is accepted for the day the connection is not internal.

**Auth surface.** None. `src/plugins/auth.ts`, `src/routes/auth.ts`,
`src/lib/session.ts`, and `src/lib/password.ts` are not touched. The existing
`keyGenerator` is unchanged, including its known property that an authenticated
attacker holding many accounts is keyed per account — unchanged from today, and
bounded by the registration limit rather than by this feature.

**Lua and injection.** The script is the one shipped by `@fastify/rate-limit`,
invoked with the key as a `KEYS` argument, and the key is hex from an HMAC. There is
no string concatenation of user input into a script.

## Observability

- **`rate_limit_store_operations_total{store="redis"|"local",outcome="ok"|"error"}`** —
  a prom-client counter registered on the existing custom registry in
  `src/plugins/metrics.ts`. This is the single signal that says whether the limiter
  is actually distributed right now. `{store="local"}` rising while `REDIS_URL` is
  set means degraded mode, and is the page-worthy shape. Both flat while traffic
  flows means the store is not being consulted at all.
- **One boot log line**, beside `metrics endpoint ready` and `tracing ready`:
  `{ rateLimitStore: 'redis'|'memory', max, window, authMax }`. Never the URL. This
  is what makes "is it on right now" answerable from logs, as ADR 0007 requires.
- **An edge-triggered `warn` on degrade and `info` on recovery**, each carrying
  `{ host, port, err }` — once per transition, never per request, so a Redis outage
  produces two log lines and a moving counter rather than a flood that hides the
  incident.
- **`http_request_duration_seconds{status="429"}` stays the rejection signal.** It
  already carries rate, route, and duration; a second counter for "requests limited"
  would duplicate a histogram this repo has had since F-001. What changes after
  F-022 is that this series should **drop**, because the same traffic now shares one
  budget — a visible step down in 429s is how you confirm the switch did anything.
- **Not measured here:** Redis's own memory, hit rate, and connection count. That is
  a datastore's dashboard and it belongs with the instance, in F-022.

## Rollout

**Ships inert, in every environment, by construction rather than by flag.**
`REDIS_URL` is unset on staging and production and this feature does not set it.
With it empty, no client is constructed, `store` is not passed to the plugin, and
the executed path is identical to today's. No environment variable is required
anywhere, so — unlike `METRICS_TOKEN` — nothing here can fail a deploy for want of a
value.

**Order.**

1. Merge. No migration, no config precondition, no `openapi.json` change, no
   workflow change.
2. Confirm on staging that the boot line reads `{ rateLimitStore: 'memory' }`. Any
   other value means a `REDIS_URL` was set somewhere unexpected.
3. Provisioning and enabling is **F-022**, and it must start with staging, watch
   `rate_limit_store_operations_total` and the 429 series for an hour, and only then
   touch production. Two things for whoever does it: staging's
   `RATE_LIMIT_MAX`/`AUTH_RATE_LIMIT_MAX=100000` overrides must be reconciled first
   or the change will appear to do nothing, and the first real enablement is the
   first time shared buckets meet real traffic — a NAT'd office that used to get
   `max` per instance now gets `max` in total, so a step up in 429s for legitimate
   users is the expected shape of a limit that is too low, not a bug in this code.

**Rollback at 2am.** Unset `REDIS_URL` and restart: the code path is gone, not
flagged off, and the limiter is back to exactly today's behaviour. Nothing persists,
nothing migrated, and every leftover Redis key expires within its own window without
anybody deleting it. If the limiter is misbehaving but Redis is healthy, raising
`RATE_LIMIT_MAX` is the faster mitigation and needs no code. There is no state to
reconcile in either direction, which is the one genuinely comfortable property of
this feature.

**Diff budget.** ~430 hand-written lines: `src/lib/rate-limit-store.ts` (~120),
`src/lib/redis.ts` (~45), `src/config.ts` and `.env.example` (~40), `src/app.ts` and
`src/plugins/metrics.ts` (~30), unit tests (~90), integration tests (~90), plus
`docker-compose.yml`, `global-setup.ts`, and docs (~50) which are configuration and
prose. Comfortably inside the ~500 guidance, which is the point of F-022 existing.
**Cut order if it runs over:** first the `REDIS_TIMEOUT_MS` knob, hardcoded to 50 ms;
second the recovery `info` line, keeping only the degrade `warn`. Never the
fallback path, the key hashing, or the two-instance test — those three are the
feature.
