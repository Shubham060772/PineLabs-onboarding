import { ensureEnv } from '../scripts/env.js';
import { startLocalDatabase } from '../scripts/local-db.js';
import pg from 'pg';
export default async function () {
  ensureEnv();
  const local = await startLocalDatabase();
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  if (!(await client.query("SELECT 1 FROM pg_database WHERE datname='onboard_test'")).rowCount)
    await client.query('CREATE DATABASE onboard_test');
  await client.end();
  process.env.DATABASE_URL = process.env.DATABASE_URL!.replace(/\/[^/]+$/, '/onboard_test');
  const { migrate } = await import('../scripts/migrate.js');
  await migrate();
  const { pool } = await import('../apps/api/src/db.js');
  await pool.end();
  return async () => {
    if (local) await local.stop();
  };
}
