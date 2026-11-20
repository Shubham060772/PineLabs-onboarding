import { buildServer } from './server.js';
import { startWorker } from './jobs.js';
import { config } from './config.js';
import { pool } from './db.js';
const server = await buildServer(process.env.LOG_REQUESTS === 'true');
await server.listen({ port: config.port, host: '127.0.0.1' });
const stop = config.worker ? startWorker() : async () => {};
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, async () => {
    await stop();
    await server.close();
    await pool.end();
    process.exit(0);
  });
