/**
 * Regenerates openapi.json from the running route schemas.
 * `--check` fails when the committed spec has drifted, so an agent cannot change
 * the public API contract without the diff showing up in review.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { buildApp } from '../src/app.js';
import type { Config } from '../src/config.js';

const SPEC_PATH = new URL('../openapi.json', import.meta.url);

const config: Config = {
  NODE_ENV: 'test',
  PORT: 3000,
  HOST: '127.0.0.1',
  DATABASE_URL: 'postgres://unused',
  DATABASE_POOL_MAX: 1,
  COOKIE_SECRET: 'x'.repeat(32),
  SESSION_TTL_HOURS: 168,
  IDEMPOTENCY_TTL_HOURS: 24,
  LOG_LEVEL: 'fatal',
  RATE_LIMIT_MAX: 100,
  RATE_LIMIT_WINDOW: '1 minute',
  AUTH_RATE_LIMIT_MAX: 10,
  PASSWORD_RESET_TTL_MINUTES: 30,
  PASSWORD_RESET_RATE_LIMIT_MAX: 5,
  EMAIL_VERIFICATION_TTL_HOURS: 24,
  // `drop` rather than the `console` default: this script must never be the
  // thing that prints a token, and it sends no mail anyway.
  MAIL_TRANSPORT: 'drop',
  // Empty is what a developer machine runs; `/metrics` is hidden from the
  // contract either way, so the token state cannot affect this dump.
  METRICS_TOKEN: '',
  TRUST_PROXY: false,
  ALLOWED_ORIGINS: '',
  // Deliberately a path with no client: the web routes are hidden from the
  // contract anyway, and this keeps the dump from tripping the boot rule in
  // src/routes/web.ts on a machine that has just run `npm run build`.
  WEB_ROOT: 'dist/no-web-client',
  SHUTDOWN_GRACE_MS: 0,
  // Tracing changes no route schema, so the dump runs with it off — the same
  // configuration every deployed environment runs (ADR 0012).
  OTEL_EXPORTER_OTLP_ENDPOINT: '',
  OTEL_EXPORTER_OTLP_HEADERS: '',
  OTEL_SERVICE_NAME: 'agentic-todo',
  TRACE_SAMPLE_RATIO: 0.1,
  // No shared store, so no client is built and no connection is attempted —
  // the same configuration every deployed environment runs (ADR 0018), and the
  // limiter changes no route schema either way.
  REDIS_URL: '',
  REDIS_TIMEOUT_MS: 50,
  // Off, like every deployed environment: the cache changes no route schema, no
  // status code, and no response body, so openapi.json is identical either way.
  TODO_LIST_CACHE_ENABLED: false,
  TODO_LIST_CACHE_TTL_SECONDS: 30,
};

// The spec is derived from route schemas only; no query is ever executed.
const app = await buildApp(config, {} as never);
const spec = JSON.stringify(app.swagger(), null, 2) + '\n';
await app.close();

if (process.argv.includes('--check')) {
  const current = await readFile(SPEC_PATH, 'utf8').catch(() => '');
  if (current !== spec) {
    console.error('openapi.json is out of date. Run `npm run openapi:dump` and commit the result.');
    process.exit(1);
  }
  console.log('openapi.json is up to date.');
} else {
  await writeFile(SPEC_PATH, spec);
  console.log('Wrote openapi.json');
}
