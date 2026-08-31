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
  LOG_LEVEL: 'fatal',
  RATE_LIMIT_MAX: 100,
  RATE_LIMIT_WINDOW: '1 minute',
  TRUST_PROXY: false,
  ALLOWED_ORIGINS: '',
  SHUTDOWN_GRACE_MS: 0,
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
