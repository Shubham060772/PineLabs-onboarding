import 'dotenv/config';
import { readFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
const config = JSON.parse(
  await readFile('.local/ai-runtime.json', 'utf8').catch(() => {
    throw new Error('Run npm run ai:setup first.');
  }),
);
async function locate(dir: string): Promise<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  if (entries.some((e) => e.name === 'llama-server.exe')) return path.join(dir, 'llama-server.exe');
  for (const entry of entries)
    if (entry.isDirectory()) {
      const found = await locate(path.join(dir, entry.name));
      if (found) return found;
    }
  return '';
}
const exe = await locate(config.runtime);
if (!exe) throw new Error('llama-server executable is missing. Run npm run ai:setup.');
const child = spawn(
  exe,
  [
    '-m',
    config.model,
    '--mmproj',
    config.projector,
    '--host',
    '127.0.0.1',
    '--port',
    '8081',
    '--alias',
    'qwen3-vl-2b',
    '-c',
    '4096',
    '-np',
    '1',
    '-ngl',
    '99',
    ...(process.env.LOCAL_MODEL_DEVICE ? ['--device', process.env.LOCAL_MODEL_DEVICE] : []),
    '--no-webui',
    '--log-disable',
  ],
  { stdio: 'inherit', windowsHide: true },
);
child.on('error', () => {
  console.error('Could not start local model server.');
  process.exitCode = 1;
});
child.on('exit', (code) => process.exit(code ?? 1));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill());
