import { buildMockServer, startDeliveries } from './server.js';
import { config } from '../../api/src/config.js';
import { pool } from '../../api/src/db.js';
const app = await buildMockServer();
await app.listen({ port: config.mockPort, host: '127.0.0.1' });
const stop = startDeliveries();
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, async () => {
    await stop();
    await app.close();
    await pool.end();
    process.exit(0);
  });
