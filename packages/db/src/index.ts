import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import * as schema from './schema';

export type DatabasePool = Pool;
export type DatabaseClient = PoolClient;

export function createPool(connectionString = process.env.DATABASE_URL): Pool {
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const config: PoolConfig = {
    connectionString,
    max: Number(process.env.DATABASE_POOL_SIZE ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  };
  return new Pool(config);
}

export function createDatabase(pool: Pool) {
  return drizzle(pool, { schema });
}

export async function inTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function migrate(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rat_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const migrationName = '0001_initial.sql';
  const applied = await pool.query<{ name: string }>('SELECT name FROM rat_migrations WHERE name = $1', [
    migrationName,
  ]);
  if (applied.rowCount) return;

  const currentDirectory = dirname(fileURLToPath(import.meta.url));
  const migrationPath = resolve(currentDirectory, '../migrations', migrationName);
  const sql = await readFile(migrationPath, 'utf8');
  await pool.query(sql);
  await pool.query('INSERT INTO rat_migrations (name) VALUES ($1)', [migrationName]);
}

export * from './schema';
