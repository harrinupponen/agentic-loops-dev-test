import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp, type BuildOptions } from '../../src/app.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Database } from '../../src/db/client.js';

export interface TestContext {
  app: FastifyInstance;
  db: Database;
  config: Config;
  close: () => Promise<void>;
}

/**
 * A path with no client in it. CI runs the integration suite before any build,
 * but a developer who runs it after one would otherwise trip the boot rule in
 * src/routes/web.ts and see every test fail for an unrelated reason. Web tests
 * opt in to serving by overriding WEB_ROOT with the fixture client.
 */
export const NO_WEB_CLIENT = 'tests/fixtures/no-web-client';

export async function createTestContext(
  overrides: Record<string, string> = {},
  options: BuildOptions = {},
) {
  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    COOKIE_SECRET: 'test-cookie-secret-that-is-long-enough-x',
    RATE_LIMIT_MAX: '10000',
    SHUTDOWN_GRACE_MS: '0',
    ALLOWED_ORIGINS: '',
    WEB_ROOT: NO_WEB_CLIENT,
    ...overrides,
  });

  const { pool, db } = createDb(config.DATABASE_URL, 5);
  let app: FastifyInstance;
  try {
    app = await buildApp(config, db, options);
  } catch (error) {
    // buildApp can refuse to start; do not leak the pool when it does.
    await pool.end();
    throw error;
  }

  return {
    app,
    db,
    config,
    close: async () => {
      await app.close();
      await pool.end();
    },
  } satisfies TestContext;
}

/** Cascading truncate keeps tests independent without paying for a fresh schema. */
export async function resetDb(db: Database) {
  await db.execute(
    sql`TRUNCATE TABLE idempotency_keys, todos, sessions, users RESTART IDENTITY CASCADE`,
  );
}

/** Registers a user and returns the cookie header for authenticated requests. */
export async function registerUser(app: FastifyInstance, email = `u${Date.now()}@example.com`) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'correct-horse-battery-staple' },
  });
  if (res.statusCode !== 201) throw new Error(`register failed: ${res.statusCode} ${res.body}`);
  const setCookie = res.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie[0]! : String(setCookie);
  return { cookie: raw.split(';')[0]!, user: res.json<{ id: string; email: string }>() };
}
