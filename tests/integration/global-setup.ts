import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { runMigrations } from '../../src/db/migrate.js';

let container: StartedPostgreSqlContainer | undefined;
let redis: StartedTestContainer | undefined;

/**
 * Uses DATABASE_URL when one is supplied (CI service container), otherwise spins
 * up a throwaway Postgres. Same code path, same schema, no mocks either way.
 *
 * Redis follows the identical pattern, with one difference that matters: it is
 * published as TEST_REDIS_URL, never as REDIS_URL. Every test context must keep
 * defaulting to the in-memory store — the one every deployed environment runs
 * (ADR 0018) — so the cases that want a shared store opt in explicitly.
 */
export default async function setup() {
  let url = process.env.DATABASE_URL;

  if (!url) {
    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('app_test')
      .withUsername('app')
      .withPassword('app')
      .start();
    url = container.getConnectionUri();
    process.env.DATABASE_URL = url;
  }

  if (!process.env.TEST_REDIS_URL) {
    // No persistence: a rate-limit keyspace is disposable by construction.
    redis = await new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .withCommand(['redis-server', '--appendonly', 'no'])
      .start();
    process.env.TEST_REDIS_URL = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
  }

  await runMigrations(url);

  return async () => {
    await container?.stop();
    await redis?.stop();
  };
}
