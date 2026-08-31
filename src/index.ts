import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { buildApp } from './app.js';

const config = loadConfig();
const { pool, db } = createDb(config.DATABASE_URL, config.DATABASE_POOL_MAX);
const app = await buildApp(config, db);

await app.listen({ port: config.PORT, host: config.HOST });

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutdown initiated');

  // Flip readiness first and keep serving. The load balancer needs a moment to
  // notice before we stop accepting connections, otherwise deploys drop requests.
  app.isShuttingDown = true;
  await new Promise((resolve) => setTimeout(resolve, config.SHUTDOWN_GRACE_MS));

  try {
    await app.close();
    await pool.end();
    app.log.info('shutdown complete');
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'shutdown failed');
    process.exit(1);
  }
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => void shutdown(signal));
}

process.on('unhandledRejection', (err) => {
  app.log.fatal({ err }, 'unhandled rejection');
  process.exit(1);
});
