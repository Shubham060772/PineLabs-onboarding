import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { ensureEnv } from './env.js';
import dotenv from 'dotenv';
ensureEnv();
const { startLocalDatabase } = await import('./local-db.js');
const db = await startLocalDatabase();
const { migrate } = await import('./migrate.js');
await migrate();
if (!existsSync('fixtures/extractions.json')) {
  const { generateFixtures } = await import('./fixtures.js');
  await generateFixtures();
}
const { seedUsers, seedApplications } = await import('./seed.js');
await seedUsers();
const children: ChildProcess[] = [];
function child(file: string, args: string[] = []) {
  const p = spawn(process.execPath, ['--import', 'tsx', file, ...args], {
    stdio: 'inherit',
    windowsHide: true,
    env: process.env,
  });
  children.push(p);
  p.on('exit', (code) => {
    if (code && !stopping) console.error(`${file} exited with code ${code}`);
  });
  return p;
}
async function ready(url: string) {
  for (let i = 0; i < 900; i++) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(500) })).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${url} did not become ready`);
}
let stopping = false;
let apiProcess: ChildProcess;
async function start() {
  if (process.env.EXTRACTOR === 'local') {
    const url =
      (process.env.LOCAL_MODEL_URL ?? 'http://127.0.0.1:8081/v1').replace(/\/$/, '') + '/models';
    const online = await fetch(url, { signal: AbortSignal.timeout(1000) }).then(
      (r) => r.ok,
      () => false,
    );
    if (!online) {
      child('scripts/start-ai.ts');
      await ready(url);
    }
  }
  apiProcess = child('apps/api/src/index.ts');
  child('apps/mock-providers/src/index.ts');
  await ready(`${process.env.API_URL ?? 'http://127.0.0.1:3001'}/health`);
  await ready(`${process.env.MOCK_URL ?? 'http://127.0.0.1:3002'}/health`);
}
async function stopChildren() {
  await Promise.all(
    children.splice(0).map(
      (p) =>
        new Promise<void>((resolve) => {
          if (p.exitCode !== null || p.signalCode !== null) {
            resolve();
            return;
          }
          p.once('exit', () => resolve());
          p.kill();
        }),
    ),
  );
}
try {
  await start();
  child('node_modules/vite/bin/vite.js', ['--config', 'apps/web/vite.config.ts']);
  await ready('http://localhost:5173');
  if (process.env.AUTO_SEED_DEMO === 'true') await seedApplications();
} catch (error) {
  stopping = true;
  await stopChildren();
  const { pool } = await import('../apps/api/src/db.js');
  await pool.end();
  if (db) await db.stop();
  throw error;
}
console.log(
  '\nOnboard is ready: http://localhost:5173\nMerchant: merchant@onboard.demo\nOperator: operator@onboard.demo\nPassword: DemoPass123!\n',
);
writeFileSync('.local/dev-ready', String(process.pid));
let resetting = false;
const watcher = setInterval(async () => {
  if (!resetting && existsSync('.local/restart-api-request.json')) {
    resetting = true;
    const request = JSON.parse(readFileSync('.local/restart-api-request.json', 'utf8'));
    unlinkSync('.local/restart-api-request.json');
    try {
      await new Promise<void>((resolve) => {
        if (apiProcess.exitCode !== null || apiProcess.signalCode !== null) resolve();
        else {
          apiProcess.once('exit', () => resolve());
          apiProcess.kill();
        }
      });
      dotenv.config({ override: true, quiet: true });
      apiProcess = child('apps/api/src/index.ts');
      await ready(`${process.env.API_URL ?? 'http://127.0.0.1:3001'}/health`);
      writeFileSync('.local/restart-api-result.json', JSON.stringify({ id: request.id, ok: true }));
    } catch (error) {
      writeFileSync(
        '.local/restart-api-result.json',
        JSON.stringify({ id: request.id, ok: false }),
      );
    } finally {
      resetting = false;
    }
    return;
  }
  if (resetting || !existsSync('.local/reset-request.json')) return;
  resetting = true;
  const request = JSON.parse(readFileSync('.local/reset-request.json', 'utf8'));
  unlinkSync('.local/reset-request.json');
  try {
    stopping = true;
    await stopChildren();
    const { resetData } = await import('./reset.js');
    await resetData();
    await seedUsers();
    stopping = false;
    await start();
    child('node_modules/vite/bin/vite.js', ['--config', 'apps/web/vite.config.ts']);
    await seedApplications();
    writeFileSync('.local/reset-result.json', JSON.stringify({ id: request.id, ok: true }));
  } catch (e) {
    writeFileSync(
      '.local/reset-result.json',
      JSON.stringify({
        id: request.id,
        ok: false,
        error: e instanceof Error ? e.message : 'Reset failed',
      }),
    );
  } finally {
    resetting = false;
  }
}, 1000);
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(watcher);
  await stopChildren();
  if (existsSync('.local/dev-ready')) unlinkSync('.local/dev-ready');
  const { pool } = await import('../apps/api/src/db.js');
  await pool.end();
  if (db) await db.stop();
  process.exit(0);
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, shutdown);
