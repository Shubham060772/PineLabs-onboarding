import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { pathToFileURL } from 'node:url';
import { ensureEnv } from './env.js';
ensureEnv();
export async function startLocalDatabase() {
  const connectionString = process.env.DATABASE_URL!;
  const probe = new pg.Client({ connectionString, connectionTimeoutMillis: 1500 });
  try {
    await probe.connect();
    await probe.end();
    return null;
  } catch {
    await probe.end().catch(() => {});
  }
  const url = new URL(connectionString);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== '54329')
    throw new Error('Configured database is unavailable. Start it before launching Onboard.');
  const databaseDir = path.resolve('.local/postgres');
  const db = new EmbeddedPostgres({
    databaseDir,
    user: 'onboard',
    password: 'onboard',
    port: 54329,
    persistent: true,
    authMethod: 'scram-sha-256',
    postgresFlags: ['-h', '127.0.0.1'],
    onLog: () => {},
    onError: () => {},
  });
  if (!existsSync(path.join(databaseDir, 'PG_VERSION'))) await db.initialise();
  await db.start();
  const client = db.getPgClient('postgres');
  await client.connect();
  const found = await client.query("SELECT 1 FROM pg_database WHERE datname='onboard'");
  if (!found.rowCount) await client.query('CREATE DATABASE onboard');
  await client.end();
  console.log('Local PostgreSQL ready on 127.0.0.1:54329.');
  return db;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = await startLocalDatabase();
  if (db) {
    process.on('SIGINT', async () => {
      await db.stop();
      process.exit(0);
    });
    await new Promise(() => {});
  }
}
