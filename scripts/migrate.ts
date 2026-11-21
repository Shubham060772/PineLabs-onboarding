import { ensureEnv } from './env.js';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
ensureEnv();
export async function migrate() {
  const { pool, transaction } = await import('../apps/api/src/db.js');
  await transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(1954321)');
    const exists = await tx.query("SELECT to_regclass('public.schema_migrations') AS name");
    if (!exists.rows[0].name)
      await tx.query(await readFile('apps/api/migrations/001_initial.sql', 'utf8'));
    if (!(await tx.query('SELECT 1 FROM schema_migrations WHERE version=2')).rowCount)
      await tx.query(await readFile('apps/api/migrations/002_rejection_closure.sql', 'utf8'));
  });
  console.log('Database migrations are current.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await migrate();
  const { pool } = await import('../apps/api/src/db.js');
  await pool.end();
}
