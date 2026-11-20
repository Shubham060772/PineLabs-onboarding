import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import dotenv from 'dotenv';
export function ensureEnv() {
  if (!existsSync('.env')) {
    let contents = readFileSync('.env.example', 'utf8');
    for (const key of [
      'JWT_SECRET',
      'ENCRYPTION_KEY',
      'BLIND_INDEX_KEY',
      'WEBHOOK_SECRET_PAN',
      'WEBHOOK_SECRET_GST',
      'WEBHOOK_SECRET_BANK',
      'WEBHOOK_SECRET_RISK',
      'MOCK_ADMIN_SECRET',
    ])
      contents = contents.replace(
        new RegExp(`^${key}=$`, 'm'),
        `${key}=${randomBytes(32).toString('hex')}`,
      );
    writeFileSync('.env', contents, { mode: 0o600 });
  }
  mkdirSync('.local', { recursive: true });
  dotenv.config({ quiet: true } as any);
}
