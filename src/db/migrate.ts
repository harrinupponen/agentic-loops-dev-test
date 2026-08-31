import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// Two levels up resolves to the repo root in dev (src/db/) and to /app in the
// runtime image (dist/db/), so the same path works in both.
const MIGRATIONS_DIR = fileURLToPath(new URL('../../drizzle/', import.meta.url));
const LOCK_KEY = 8_472_913;

/**
 * Applies pending .sql migrations in filename order, each in its own
 * transaction, holding a Postgres advisory lock so concurrent instances or
 * deploys cannot race.
 */
export async function runMigrations(connectionString: string): Promise<string[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const applied: string[] = [];

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name       text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);

    const done = new Set(
      (await client.query<{ name: string }>('SELECT name FROM _migrations')).rows.map(
        (r) => r.name,
      ),
    );
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    await client.end();
  }

  return applied;
}

/**
 * CLI entrypoint. Runs at container start, before the server, so the schema is
 * always ahead of the code. Safe to run from every instance simultaneously
 * because of the advisory lock, and safe against the previous version because
 * CI forbids destructive migrations shipping with app code (ADR 0003).
 */
if (process.argv[1] && /migrate\.(ts|js)$/.test(process.argv[1])) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  const applied = await runMigrations(url);
  console.error(applied.length ? `Applied: ${applied.join(', ')}` : 'No pending migrations');
}
