// Development recovery for an interrupted first seed. Never run against another database.
import { resetData } from './reset.js';
await resetData();
const { pool } = await import('../apps/api/src/db.js');
await pool.end();
