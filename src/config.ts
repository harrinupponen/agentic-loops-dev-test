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
  return result.data;
}

export function allowedOrigins(config: Config): string[] {
  return config.ALLOWED_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}
