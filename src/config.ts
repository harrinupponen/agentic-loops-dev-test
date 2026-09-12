import { z } from 'zod';

const boolish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),

  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),

  COOKIE_SECRET: z.string().min(32, 'COOKIE_SECRET must be at least 32 characters'),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).default(168),

  /** How long a stored idempotency outcome stays replayable. */
  IDEMPOTENCY_TTL_HOURS: z.coerce.number().int().min(1).default(24),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(100),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),
  // Deliberately tighter than RATE_LIMIT_MAX and configured separately: auth
  // endpoints are the cheapest place to mount a credential-stuffing attack.
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(10),
  /** How long an emailed password-reset token stays usable. */
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(1).default(30),
  /**
   * Per hour, per IP. Far tighter than AUTH_RATE_LIMIT_MAX because this route
   * costs someone else an email; the per-account cooldown in the upsert is what
   * bounds abuse aimed at one victim.
   */
  PASSWORD_RESET_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(5),
  /**
   * How long an emailed verification token stays usable. Hours, not minutes: a
   * reset token is used within minutes of being asked for, while a verification
   * mail is routinely opened the next morning.
   */
  EMAIL_VERIFICATION_TTL_HOURS: z.coerce.number().int().min(1).default(24),
  /**
   * `console` prints the reset token to stdout for local development and
   * refuses to boot under NODE_ENV=production; `drop` sends nothing and is what
   * production runs until a real transport exists. See src/lib/mailer.ts.
   */
  MAIL_TRANSPORT: z.enum(['console', 'drop']).default('console'),
  /**
   * Bearer token that `/metrics` is served behind. Empty = the endpoint is
   * open, which loadConfig refuses to allow in production; see the check there.
   */
  METRICS_TOKEN: z.string().default(''),
  TRUST_PROXY: boolish.default(false),
  /**
   * Comma-separated origin allowlist used for the CSRF origin check. Empty =
   * check disabled, which is why serving a browser client with an empty value
   * is a boot failure — see src/routes/web.ts and ADR 0007.
   */
  ALLOWED_ORIGINS: z.string().default(''),
  /** Directory holding the built browser client (index.html plus app/). */
  WEB_ROOT: z.string().min(1).default('dist/public'),
  SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).default(10_000),

  /**
   * Base URL of an OTLP/HTTP collector, e.g. `http://localhost:4318`; the
   * `/v1/traces` signal path is appended for you. Empty — the value in every
   * deployed environment — means no SDK is constructed and no span is recorded
   * (docs/adr/0012-traces-without-a-backend.md).
   */
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default(''),
  /** `k=v,k2=v2` sent on every export. A credential: never logged, never on a span. */
  OTEL_EXPORTER_OTLP_HEADERS: z.string().default(''),
  OTEL_SERVICE_NAME: z.string().min(1).default('agentic-todo'),
  /** Head sampling ratio for root and remote-parent spans alike. */
  TRACE_SAMPLE_RATIO: z.coerce.number().min(0).max(1).default(0.1),

  /**
   * `redis://` or `rediss://` connection URL for the shared rate-limit counter.
   * Empty — the value in every deployed environment — means no client is
   * constructed and the limiter keeps the plugin's own per-instance store, at
   * exactly today's strength (docs/adr/0018-a-shared-limiter-needs-a-store-nobody-has-bought.md).
   * A CREDENTIAL: it carries a password, so it is never logged.
   */
  REDIS_URL: z.string().default(''),
  /**
   * Per-command budget. A command that does not answer inside it is a store
   * failure and the request falls back to the local window (ADR 0019), so a
   * sick-but-reachable Redis cannot become request latency.
   */
  REDIS_TIMEOUT_MS: z.coerce.number().int().min(1).max(1000).default(50),
});

export type Config = z.infer<typeof EnvSchema>;

/**
 * Parse and validate environment. Throws with a readable report on failure so a
 * misconfigured deploy dies at boot rather than at first request.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  if (result.data.NODE_ENV === 'production' && result.data.COOKIE_SECRET.includes('replace-me')) {
    throw new Error('COOKIE_SECRET is still the example value; refusing to boot in production.');
  }
  // `/metrics` shares the public port and has no ingress protection in front of
  // it, and `mail_messages_total{kind="password_reset",outcome="sent"}` only
  // moves for an address that has an account — unauthenticated, that is a user
  // enumeration oracle. So a deployed environment must carry a real token or it
  // does not start.
  //
  // Following ADR 0007, the check runs where the condition is knowable: what
  // makes the exposure matter is being internet-reachable, and NODE_ENV is the
  // only signal this process has for that. Outside production the default stays
  // empty and `/metrics` stays open, deliberately — `curl localhost:3000/metrics`
  // has to keep working for local dev, the integration suite scrapes counters
  // constantly, and the boot check means the open path cannot exist anywhere an
  // attacker can reach. The 32-character floor mirrors COOKIE_SECRET: this is a
  // credential, and a guessable one is the same as none.
  const metricsToken = result.data.METRICS_TOKEN;
  if (result.data.NODE_ENV === 'production') {
    if (!metricsToken) {
      throw new Error(
        'METRICS_TOKEN is unset while NODE_ENV=production; /metrics would be served ' +
          'unauthenticated on the public port. Set it to at least 32 random characters ' +
          '(openssl rand -base64 48).',
      );
    }
    if (metricsToken.includes('replace-me')) {
      throw new Error('METRICS_TOKEN is still the example value; refusing to boot in production.');
    }
    if (metricsToken.length < 32) {
      throw new Error('METRICS_TOKEN must be at least 32 characters; refusing to boot.');
    }
  }
  validateTracing(result.data);
  validateRedis(result.data);
  return result.data;
}

/**
 * Two boot rules, and deliberately no third one requiring REDIS_URL in
 * production: an empty value removes no control, it leaves the per-instance
 * limiter running exactly as it does today, and the boot log line says which
 * store is live. That is the narrow, argued departure from ADR 0007 — see
 * docs/adr/0018-a-shared-limiter-needs-a-store-nobody-has-bought.md.
 *
 * A value that is set and wrong is a different matter and fails the boot in
 * every NODE_ENV: a typo would otherwise leave the limiter silently counting
 * per instance forever, which is the failure this feature exists to remove.
 */
function validateRedis(config: Config): void {
  if (!config.REDIS_URL) return;

  let url: URL;
  try {
    url = new URL(config.REDIS_URL);
  } catch {
    // Never echoes the value: it carries a password.
    throw new Error(
      'REDIS_URL is not an absolute URL. Expected a connection URL such as ' + 'redis://host:6379.',
    );
  }
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new Error(
      `REDIS_URL must use the redis: or rediss: scheme (got "${url.protocol}"). ` +
        'A connection string for another datastore would be retried in a loop forever.',
    );
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Three boot rules for the OTLP exporter, all ADR 0007 shaped: the process
 * refuses to start rather than exporting a credential in clear, or staying
 * silent because of a typo.
 */
function validateTracing(config: Config): void {
  const endpoint = config.OTEL_EXPORTER_OTLP_ENDPOINT;

  if (!endpoint) {
    // Headers with nowhere to send them means somebody believes tracing is on
    // when it is off — and a credential is sitting in an environment for
    // nothing.
    if (config.OTEL_EXPORTER_OTLP_HEADERS) {
      throw new Error(
        'OTEL_EXPORTER_OTLP_HEADERS is set while OTEL_EXPORTER_OTLP_ENDPOINT is empty, so ' +
          'tracing is off and those headers are a credential nothing will ever use. Set the ' +
          'endpoint or unset the headers.',
      );
    }
    return;
  }

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(
      `OTEL_EXPORTER_OTLP_ENDPOINT is not an absolute URL (got "${endpoint}"). Expected a ` +
        'collector base URL such as http://localhost:4318.',
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(
      `OTEL_EXPORTER_OTLP_ENDPOINT must be an http(s) URL (got "${url.protocol}"). ` +
        'This exporter speaks OTLP over HTTP.',
    );
  }

  // Plaintext OTLP to anything but a sidecar puts OTEL_EXPORTER_OTLP_HEADERS —
  // a credential — on the wire in clear, and spans are the one signal designed
  // to leave the perimeter.
  if (
    config.NODE_ENV === 'production' &&
    url.protocol === 'http:' &&
    !LOOPBACK_HOSTS.has(url.hostname)
  ) {
    throw new Error(
      'OTEL_EXPORTER_OTLP_ENDPOINT uses plaintext http:// to a non-loopback host under ' +
        'NODE_ENV=production; refusing to boot. Use https://, or a collector on localhost.',
    );
  }
}

export function allowedOrigins(config: Config): string[] {
  return config.ALLOWED_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}
