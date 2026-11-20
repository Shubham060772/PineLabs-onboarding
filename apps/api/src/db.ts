import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from './config.js';
import {
  AppError,
  type Actor,
  type AppStatus,
  type Form,
  assertTransition,
  assertAttemptTransition,
  type AttemptStatus,
} from '../../../packages/shared/src/index.js';
import { decrypt, sanitize } from './crypto.js';
export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 12 });
export const correlationContext = new AsyncLocalStorage<string>();
export type Tx = pg.PoolClient;
export type Application = {
  id: string;
  reference: string;
  owner_user_id: string;
  status: AppStatus;
  data_version: number;
  form_enc: string;
  legal_name: string;
  created_at: Date;
  status_changed_at: Date;
  submitted_at: Date | null;
  approved_at: Date | null;
  approved_by: string | null;
  [key: string]: any;
};
export async function transaction<T>(fn: (tx: Tx) => Promise<T>) {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const result = await fn(tx);
    await tx.query('COMMIT');
    return result;
  } catch (e) {
    await tx.query('ROLLBACK');
    throw e;
  } finally {
    tx.release();
  }
}
export async function lockApp(tx: Tx, id: string) {
  const { rows } = await tx.query<Application>(
    'SELECT * FROM applications WHERE id=$1 FOR UPDATE',
    [id],
  );
  if (!rows[0]) throw new AppError('NOT_FOUND', 'Application not found', 404);
  return rows[0];
}
export const formOf = (app: Application) => decrypt<Form>(app.form_enc);
export async function audit(
  tx: Tx,
  appId: string | null,
  event: string,
  actor: Actor,
  data: unknown = {},
  from?: string,
  to?: string,
) {
  await tx.query(
    'INSERT INTO audit_events(application_id,event_type,actor_type,actor_id,data,from_status,to_status,correlation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [
      appId,
      event,
      actor.type,
      actor.id ?? null,
      JSON.stringify(sanitize(data)),
      from ?? null,
      to ?? null,
      actor.correlation_id ?? correlationContext.getStore() ?? null,
    ],
  );
}
export async function transition(tx: Tx, app: Application, to: AppStatus, actor: Actor) {
  assertTransition(app.status, to);
  const from = app.status;
  await tx.query('UPDATE applications SET status=$2,status_changed_at=now() WHERE id=$1', [
    app.id,
    to,
  ]);
  await audit(tx, app.id, 'STATE_CHANGED', actor, {}, from, to);
  app.status = to;
}
export async function enqueue(
  tx: Tx,
  type: string,
  appId: string,
  payload: unknown = {},
  dedupe?: string,
  runAt = new Date(),
) {
  const max = type === 'INTAKE' ? 3 : type === 'CHECK_TIMEOUT' ? 5 : 4;
  await tx.query(
    `INSERT INTO jobs(type,application_id,payload,dedupe_key,max_attempts,run_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (dedupe_key) WHERE status IN ('PENDING','RUNNING') DO NOTHING`,
    [
      type,
      appId,
      JSON.stringify({ ...(payload as object), correlation_id: correlationContext.getStore() }),
      dedupe ?? null,
      max,
      runAt,
    ],
  );
}

// The caller already holds the application lock. The status predicate also protects
// dispatch completion from overwriting an early callback or a superseded attempt.
export async function changeAttempt(
  tx: Tx,
  attempt: { id: string; status: AttemptStatus },
  to: AttemptStatus,
  patch: {
    provider_request_id?: string;
    dispatched_at?: Date;
    deadline_at?: Date;
    completed_at?: Date;
    result?: unknown;
  } = {},
) {
  assertAttemptTransition(attempt.status, to);
  const values: unknown[] = [attempt.id, to, attempt.status];
  const fields = ['status=$2'];
  for (const key of [
    'provider_request_id',
    'dispatched_at',
    'deadline_at',
    'completed_at',
    'result',
  ] as const) {
    if (patch[key] !== undefined) {
      values.push(key === 'result' ? JSON.stringify(patch[key]) : patch[key]);
      fields.push(`${key}=$${values.length}`);
    }
  }
  const result = await tx.query(
    `UPDATE check_attempts SET ${fields.join(',')} WHERE id=$1 AND status=$3 RETURNING id`,
    values,
  );
  return result.rowCount === 1;
}
export async function supersedeAttempts(tx: Tx, appId: string, checkId?: string) {
  const { rows } = await tx.query(
    "SELECT id,status FROM check_attempts WHERE application_id=$1 AND status IN ('QUEUED','AWAITING_CALLBACK') AND ($2::uuid IS NULL OR check_id=$2)",
    [appId, checkId ?? null],
  );
  for (const attempt of rows)
    await changeAttempt(tx, attempt, 'SUPERSEDED', { completed_at: new Date() });
}
