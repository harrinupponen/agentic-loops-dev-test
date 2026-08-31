// Local/dev wrapper. Production runs dist/db/migrate.js from the entrypoint.
import { runMigrations } from '../src/db/migrate.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');

const applied = await runMigrations(url);
console.error(applied.length ? `Applied: ${applied.join(', ')}` : 'No pending migrations');
