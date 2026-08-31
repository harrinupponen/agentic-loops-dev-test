import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { schema } from './schema.js';

export type Database = ReturnType<typeof createDb>['db'];

export function createDb(connectionString: string, poolMax: number) {
  const pool = new pg.Pool({
    connectionString,
    max: poolMax,
    // Fail fast instead of queueing forever when the DB is saturated.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    // Guards against a single pathological query pinning a connection.
    statement_timeout: 10_000,
    query_timeout: 10_000,
  });
  const db = drizzle(pool, { schema });
  return { pool, db };
}
