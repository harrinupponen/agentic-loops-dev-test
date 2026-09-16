import type { FastifyInstance } from 'fastify';
import client from 'prom-client';
import type { Config } from '../config.js';
import { bearerToken, bearerTokenMatches } from '../lib/bearer-auth.js';
import { unauthorized } from '../lib/errors.js';
import { mailTransportStatus } from '../lib/mailer.js';
import { rateLimitStoreOperations } from '../lib/rate-limit-store.js';
import { todoListCacheOperations } from '../lib/todo-list-cache.js';
import { spansExported, tracingStatus } from '../telemetry.js';

export function registerMetrics(app: FastifyInstance, config: Config) {
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });

  // Owned by src/telemetry.ts, which runs as a `--import` preload long before
  // this registry exists — hence `registers: []` there and this line here. A
  // rising `failed` while `succeeded` is flat means the collector is rejecting
  // batches, which is otherwise only visible on stderr.
  registry.registerMetric(spansExported);

  // Owned by src/lib/rate-limit-store.ts for the same reason: the store is
  // constructed before this registry exists, because the limiter is registered
  // before the metrics plugin is.
  registry.registerMetric(rateLimitStoreOperations);

  // Owned by src/lib/todo-list-cache.ts, for the same reason: the cache is
  // constructed from buildApp, not from here.
  registry.registerMetric(todoListCacheOperations);

  const httpDuration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });

  // A steadily non-zero `replayed` proves retries are being caught; a rising
  // `conflict` means clients reuse keys incorrectly; any `takeover` at all
  // means requests are dying mid-flight.
  const idempotencyRequests = new client.Counter({
    name: 'idempotency_requests_total',
    help: 'Keyed requests by idempotency outcome',
    labelNames: ['outcome'],
    registers: [registry],
  });

  // The signal that matters is the ratio: `requested` climbing while
  // `consumed` stays flat means mail is not arriving or links are expiring.
  // `requested` increments regardless of whether the address matched an
  // account — deliberately, so this counter is not an enumeration oracle.
  const passwordResets = new client.Counter({
    name: 'password_reset_total',
    help: 'Password reset attempts by outcome',
    labelNames: ['outcome'],
    registers: [registry],
  });

  // `issued` climbing while `consumed` stays at zero means either mail is not
  // arriving or nobody can act on it — which, until a real transport exists, is
  // the expected reading in production (ADR 0011). The cooldown path increments
  // nothing, so a flat `resent` is distinguishable from a broken route.
  const emailVerifications = new client.Counter({
    name: 'email_verification_total',
    help: 'Email verification events by outcome',
    labelNames: ['outcome'],
    registers: [registry],
  });

  // The only proof that the un-awaited send actually happened. A rising
  // `failed` is page-worthy: the user already got their 202, so nothing else
  // surfaces it.
  const mailMessages = new client.Counter({
    name: 'mail_messages_total',
    help: 'Outbound mail by kind, transport, and outcome',
    labelNames: ['kind', 'transport', 'outcome'],
    registers: [registry],
  });

  // Incremented by the number of rows actually deleted, so `others` carries how
  // wide each sweep was. A sustained rise in scope="others" across accounts is a
  // population of users finding sessions they do not recognise — a
  // credential-stuffing signal arriving through the front door rather than
  // through the login error rate. No public id and no user agent as a label:
  // one is an identifier, the other is attacker-controlled text.
  const sessionsRevoked = new client.Counter({
    name: 'sessions_revoked_total',
    help: 'Sessions revoked by scope',
    labelNames: ['scope'],
    registers: [registry],
  });

  // `restored` climbing relative to `deleted` is the feature earning its keep:
  // users misclick delete, which is the premise of the whole thing. `purged`
  // flat at zero more than 30 days after launch means the sweep never runs and
  // the retention window is fiction — nothing else in the system says so, and
  // `deleted` climbing while `purged` stays near zero is the accumulation the
  // no-scheduler choice accepts (ADR 0017). `purged` advances by the number of
  // rows actually removed, so it carries how wide each sweep was. No todo id and
  // no title as a label: one is unbounded cardinality, the other is user content.
  const todosSoftDeleted = new client.Counter({
    name: 'todos_soft_delete_total',
    help: 'Todo soft delete lifecycle events by action',
    labelNames: ['action'],
    registers: [registry],
  });

  // Incremented only when `q` is present, so a plain list moves neither label.
  // The reading that matters is the ratio: `empty` dominating `match` means
  // users are not finding things — either search is not doing what they expect
  // (it is whole-word after stemming, never a prefix) or it is being used as a
  // prefix search. It is also the worst-case latency path, so a rising `empty`
  // and a rising duration are the same story. No query text as a label: it is
  // user content and unbounded cardinality, which are two independent reasons.
  const todoSearches = new client.Counter({
    name: 'todo_search_total',
    help: 'Todo searches by outcome',
    labelNames: ['outcome'],
    registers: [registry],
  });

  // The search query alone, not the whole request: `http_request_duration_seconds`
  // labels by route pattern, so a search and a plain list are indistinguishable
  // in it. This is the series that decides whether F-013's no-index decision was
  // right (ADR 0023): p95 over 100 ms or p99 over 250 ms across a day means the
  // unindexed scan has outgrown the data, and the GIN index written into that ADR
  // is the fix — one migration, no application change. Buckets follow the HTTP
  // histogram's shape so the two read the same way.
  const todoSearchDuration = new client.Histogram({
    name: 'todo_search_duration_seconds',
    help: 'Todo title search query duration in seconds',
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });

  // One increment per row successfully written. Bounded cardinality by
  // construction: the action set is closed (ADR 0025) and `outcome` has two
  // values, so at most 14 series. No user id and no email as a label — one is
  // unbounded cardinality, the other is PII. The reading that matters is
  // action="auth.login", outcome="failure" rising across the population, which
  // is credential stuffing seen from the front door rather than inferred from
  // the login error rate; it complements sessions_revoked_total{scope="others"},
  // where the same attack shows up later as users revoking sessions.
  const auditEvents = new client.Counter({
    name: 'audit_events_total',
    help: 'Security-relevant events recorded, by action and outcome',
    labelNames: ['action', 'outcome'],
    registers: [registry],
  });

  // The only counter in this application whose correct value is exactly zero,
  // and the direct consequence of ADR 0024: because a failed audit write is
  // invisible to the user by design, this is the only thing that says the trail
  // has holes. Any non-zero value means the log is incomplete and every
  // conclusion drawn from it afterwards is unsound. First alert rule for F-019.
  const auditWriteFailures = new client.Counter({
    name: 'audit_write_failures_total',
    help: 'Audit rows that could not be written (the trail has holes)',
    registers: [registry],
  });

  // Advanced by the number of rows each sweep actually removed, so it carries
  // how wide the sweep was. ADR 0017's operational tell: flat at zero for
  // longer than 90 days after launch means retention is fiction, and nothing
  // else in the system will say so.
  const auditEventsPurged = new client.Counter({
    name: 'audit_events_purged_total',
    help: 'Audit rows removed by the retention sweep',
    registers: [registry],
  });

  // Two labels for one request, deliberately: `started` increments before the
  // first byte and `completed` after the terminator is written, so
  // `started - completed` is the number of exports that died mid-stream — the
  // one failure the HTTP status code cannot carry, because it is already 200 by
  // then (ADR 0026). `failed` increments when a batch query throws, which
  // separates "the server broke" from "the client hung up". Three series, no
  // user id and no email as a label.
  const accountExports = new client.Counter({
    name: 'account_exports_total',
    help: 'Account data exports by outcome',
    labelNames: ['outcome'],
    registers: [registry],
  });

  // Over the whole stream, bucketed like todo_search_duration_seconds so the
  // two read the same way. It measures what http_request_duration_seconds
  // cannot measure honestly: that histogram observes reply.elapsedTime, which
  // for a streamed response includes the client's download time, so a user on a
  // slow link is indistinguishable from a slow query. A p95 rising while the
  // row counts are flat means the batch loop is the suspect.
  const accountExportDuration = new client.Histogram({
    name: 'account_export_duration_seconds',
    help: 'Account data export duration in seconds',
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });

  app.addHook('onResponse', (request, reply, done) => {
    // routerPath keeps cardinality bounded (`/api/todos/:id`, not one label per uuid).
    const route = request.routeOptions.url ?? 'unmatched';
    httpDuration.observe(
      { method: request.method, route, status: String(reply.statusCode) },
      reply.elapsedTime / 1000,
    );
    done();
  });

  // A monitoring endpoint, not a user session: a bearer token compared in
  // constant time, no cookie and no database round trip. An empty token means
  // no scraper credential is configured, which loadConfig only tolerates
  // outside production — see the comment there for why the endpoint is open on
  // a developer machine and closed everywhere else.
  const expectedToken = config.METRICS_TOKEN;
  app.log.info({ metricsAuth: expectedToken ? 'required' : 'disabled' }, 'metrics endpoint ready');

  // Never the endpoint and never the headers — the latter is a credential.
  // `pgInstrumented: false` with tracing enabled is the one misconfiguration
  // that silently halves this feature's value; see ADR 0013.
  const tracing = tracingStatus();
  app.log.info(tracing, 'tracing ready');
  if (tracing.tracing === 'enabled' && !tracing.pgInstrumented) {
    app.log.warn(
      'tracing started without the --import preload: server spans only, no postgres spans. ' +
        'Start the server as `node --import ./dist/telemetry.js dist/index.js`.',
    );
  }

  // "Is the limiter distributed right now" has to be answerable from the logs,
  // because an empty REDIS_URL is a deliberate and invisible state (ADR 0018).
  // Never the URL: it carries a password.
  app.log.info(
    {
      rateLimitStore: config.REDIS_URL ? 'redis' : 'memory',
      max: config.RATE_LIMIT_MAX,
      window: config.RATE_LIMIT_WINDOW,
      authMax: config.AUTH_RATE_LIMIT_MAX,
    },
    'rate limiter ready',
  );

  // "Is the cache on right now" has to be answerable from the logs too: it is
  // off by default, dark twice over, and this is the first thing to check after
  // the rollout flip. Never the URL.
  app.log.info(
    {
      todoListCache: config.TODO_LIST_CACHE_ENABLED && config.REDIS_URL ? 'redis' : 'off',
      ttlSeconds: config.TODO_LIST_CACHE_TTL_SECONDS,
    },
    'todo list cache ready',
  );

  // "Is mail live right now, and where do its links point" must be answerable
  // from the logs without reading the environment — the same reason the two
  // lines above exist. `verificationWithheld` states ADR 0030 rule 2 out loud,
  // and `unusedMailCredential` is how the boot rule deliberately NOT written
  // (a credential with nothing to use it) stays visible. Never the key itself.
  app.log.info(mailTransportStatus(config), 'mail transport ready');

  app.get(
    '/metrics',
    {
      logLevel: 'warn',
      schema: { hide: true },
      // onRequest: rejected before any metric is rendered or logged.
      onRequest: (request, _reply, done) => {
        if (!expectedToken) return done();
        if (!bearerTokenMatches(bearerToken(request.headers.authorization), expectedToken)) {
          return done(unauthorized('Metrics token required'));
        }
        done();
      },
    },
    async (_request, reply) => {
      reply.header('content-type', registry.contentType);
      return registry.metrics();
    },
  );

  return {
    registry,
    idempotencyRequests,
    passwordResets,
    emailVerifications,
    mailMessages,
    sessionsRevoked,
    todosSoftDeleted,
    todoSearches,
    todoSearchDuration,
    auditEvents,
    auditWriteFailures,
    auditEventsPurged,
    accountExports,
    accountExportDuration,
  };
}

export type Metrics = ReturnType<typeof registerMetrics>;
