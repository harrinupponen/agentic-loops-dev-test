import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runMigrations } from '../../src/db/migrate.js';

let container: StartedPostgreSqlContainer | undefined;

/**
 * Uses DATABASE_URL when one is supplied (CI service container), otherwise spins
 * up a throwaway Postgres. Same code path, same schema, no mocks either way.
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

  await runMigrations(url);

  return async () => {
    await container?.stop();
  };
}
