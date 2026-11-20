import 'dotenv/config';
import path from 'node:path';
function required(name: string) {
  const value = process.env[name];
  if (!value || value.length < 32)
    throw new Error(
      `${name} must contain at least 32 characters; run npm run dev to configure local development`,
    );
  return value;
}
export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgresql://onboard:onboard@127.0.0.1:54329/onboard',
  port: Number(process.env.API_PORT ?? 3001),
  mockPort: Number(process.env.MOCK_PORT ?? 3002),
  apiUrl: process.env.API_URL ?? 'http://127.0.0.1:3001',
  mockUrl: process.env.MOCK_URL ?? 'http://127.0.0.1:3002',
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
  storage: path.resolve(process.env.STORAGE_DIR ?? 'storage'),
  extractor: process.env.EXTRACTOR ?? 'fixture',
  model: process.env.EXTRACTION_MODEL ?? 'claude-opus-5-5',
  localModel: process.env.LOCAL_MODEL_NAME ?? 'qwen3-vl-2b',
  localModelUrl: (process.env.LOCAL_MODEL_URL ?? 'http://127.0.0.1:8081/v1').replace(/\/$/, ''),
  localModelTimeout: Number(process.env.LOCAL_MODEL_TIMEOUT_MS ?? 180000),
  demo: process.env.DEMO_MODE === 'true',
  worker: process.env.WORKER_ENABLED !== 'false',
  get jwtSecret() {
    return required('JWT_SECRET');
  },
  get encryptionKey() {
    return required('ENCRYPTION_KEY');
  },
  get blindKey() {
    return required('BLIND_INDEX_KEY');
  },
  get adminSecret() {
    return required('MOCK_ADMIN_SECRET');
  },
  webhookSecret(provider: string) {
    return required(`WEBHOOK_SECRET_${provider.toUpperCase()}`);
  },
};
