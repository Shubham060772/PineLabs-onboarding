import { ensureEnv } from './env.js';
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
ensureEnv();
export async function resetData() {
  const { config } = await import('../apps/api/src/config.js');
  const { pool } = await import('../apps/api/src/db.js');
  const db = (await pool.query('SELECT current_database() AS name')).rows[0].name;
  if (!config.demo || db !== 'onboard')
    throw new Error('Reset is restricted to DEMO_MODE=true and the onboard database');
  await pool.query(
    'TRUNCATE users,applications,documents,extracted_fields,validation_findings,info_requests,verification_checks,check_attempts,webhook_events,application_exceptions,duplicate_matches,merchants,jobs,audit_events,mock_requests,mock_scenarios,mock_merchants RESTART IDENTITY CASCADE',
  );
  await pool.query('ALTER SEQUENCE application_reference RESTART WITH 1');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!existsSync('.local/dev-ready'))
    throw new Error('Start npm run dev before resetting the running demo.');
  const id = randomUUID();
  writeFileSync('.local/reset-request.json', JSON.stringify({ id }));
  console.log('Restarting services and restoring synthetic demo data…');
  const deadline = Date.now() + 180000;
  let complete = false;
  while (Date.now() < deadline) {
    if (existsSync('.local/reset-result.json')) {
      const result = JSON.parse(readFileSync('.local/reset-result.json', 'utf8'));
      if (result.id === id) {
        if (!result.ok) throw new Error(result.error);
        complete = true;
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!complete) throw new Error('Reset timed out. Check the dev launcher output.');
  console.log('Demo restored. Sign in again to begin.');
}
