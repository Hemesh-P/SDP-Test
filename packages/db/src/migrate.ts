import { createPool, migrate } from './index';

const pool = createPool();

try {
  await migrate(pool);
  console.log('Database migrations are up to date.');
} finally {
  await pool.end();
}
