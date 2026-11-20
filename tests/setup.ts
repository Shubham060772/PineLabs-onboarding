import { ensureEnv } from '../scripts/env.js';
ensureEnv();
process.env.DATABASE_URL = process.env.DATABASE_URL!.replace(/\/[^/]+$/, '/onboard_test');
process.env.DEMO_MODE = 'true';
process.env.EXTRACTOR = 'fixture';
process.env.STORAGE_DIR = '.local/test-storage';
