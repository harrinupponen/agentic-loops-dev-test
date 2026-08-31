import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Database } from '../../src/db/client.js';

export interface TestContext {
  app: FastifyInstance;
  db: Database;
  config: Config;
  close: () => Promise<void>;
}

export async function createTestContext(overrides: Record<string, string> = {}) {
  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    COOKIE_SECRET: 'test-cookie-secret-that-is-long-enough-x',
    RATE_LIMIT_MAX: '10000',
    SHUTDOWN_GRACE_MS: '0',
    ...overrides,
  });

  const { pool, db } = createDb(config.DATABASE_URL, 5);
  const app = await buildApp(config, db);

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
  await db.execute(sql`TRUNCATE TABLE todos, sessions, users RESTART IDENTITY CASCADE`);
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
