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

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(100),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),
  TRUST_PROXY: boolish.default(false),
  /** Comma-separated origin allowlist used for the CSRF origin check. Empty = check disabled. */
  ALLOWED_ORIGINS: z.string().default(''),
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
  return result.data;
}

export function allowedOrigins(config: Config): string[] {
  return config.ALLOWED_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}
