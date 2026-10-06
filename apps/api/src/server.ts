import PgBoss from 'pg-boss';
import { createPool, migrate } from '@rat/db';
import { buildApp } from './app';
import { loadConfig } from './config';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
await migrate(pool);

const queue = new PgBoss({ connectionString: config.DATABASE_URL, application_name: 'rat-api' });
await queue.start();

const app = await buildApp({ pool, queue, config });

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await queue.stop({ graceful: true, timeout: 10_000 });
  await pool.end();
};

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.API_HOST, port: config.API_PORT });
