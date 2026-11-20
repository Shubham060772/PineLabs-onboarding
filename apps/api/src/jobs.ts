import { randomUUID } from 'node:crypto';
import {
  audit,
  enqueue,
  formOf,
  lockApp,
  pool,
  transaction,
  transition,
  type Tx,
  type Application,
  changeAttempt,
  correlationContext,
} from './db.js';
import { intake, evaluate, raiseException, timeoutAttempt } from './workflow.js';
import { merchantCore, providers, ProviderHttpError } from './providers.js';
import { OPEN_ATTEMPTS, system } from '../../../packages/shared/src/index.js';
export type Job = {
  id: string;
  type: string;
  application_id: string;
  payload: any;
  attempts: number;
  max_attempts: number;
  lease_token: string;
};
export const backoff = (attempt: number, random = Math.random()) =>
  2000 * 2 ** (attempt - 1) * (1 + 0.2 * random);
export async function claimJob(now = new Date()): Promise<Job | null> {
  // A lease token fences stale workers that finish after their job was reclaimed.
  const { rows } = await pool.query(
    `UPDATE jobs SET status='RUNNING',locked_at=$1,attempts=attempts+1,lease_token=$2 WHERE id=(SELECT id FROM jobs WHERE (status='PENDING' AND run_at<=$1) OR (status='RUNNING' AND locked_at<$1::timestamptz-interval '60 seconds') ORDER BY run_at,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,
    [now, randomUUID()],
  );
  return rows[0] ?? null;
}
async function dispatch(job: Job) {
  const snapshot = await transaction(async (tx) => {
    const app = await lockApp(tx, job.application_id);
    const {
      rows: [attempt],
    } = await tx.query(
      'SELECT a.*,c.check_type,p.timeout_seconds FROM check_attempts a JOIN verification_checks c ON c.id=a.check_id JOIN check_policies p USING(check_type) WHERE a.id=$1',
      [job.payload.attempt_id],
    );
    if (!attempt || attempt.status !== 'QUEUED' || !['VERIFYING', 'IN_REVIEW'].includes(app.status))
      return null;
    return { app, attempt };
  });
  if (!snapshot) return;
  const result = await providers.dispatch(
    snapshot.attempt.check_type,
    snapshot.attempt.id,
    snapshot.app.id,
    formOf(snapshot.app),
  );
  await transaction(async (tx) => {
    const app = await lockApp(tx, job.application_id);
    const deadline = new Date(Date.now() + Number(snapshot.attempt.timeout_seconds) * 1000);
    if (
      !(await changeAttempt(tx, snapshot.attempt, 'AWAITING_CALLBACK', {
        provider_request_id: result.provider_request_id,
        dispatched_at: new Date(),
        deadline_at: deadline,
      }))
    )
      return;
    await enqueue(
      tx,
      'CHECK_TIMEOUT',
      app.id,
      { attempt_id: snapshot.attempt.id },
      `timeout:${snapshot.attempt.id}`,
      deadline,
    );
    await audit(tx, app.id, 'CHECK_DISPATCHED', system, {
      attempt_id: snapshot.attempt.id,
      check_type: snapshot.attempt.check_type,
      deadline_at: deadline.toISOString(),
    });
  });
}
async function provision(job: Job) {
  const snapshot = await transaction(async (tx) => {
    const app = await lockApp(tx, job.application_id);
    return app.status === 'APPROVED' ? app : null;
  });
  if (!snapshot) return;
  const result = await merchantCore.create(snapshot.id, formOf(snapshot).legal_name);
  if (!/^MID[A-Z0-9]+$/.test(result.merchant_id)) throw new Error('Invalid merchant-core response');
  await transaction(async (tx) => {
    const app = await lockApp(tx, job.application_id);
    if (app.status !== 'APPROVED') return;
    await tx.query(
      'INSERT INTO merchants(application_id,merchant_id,capabilities) VALUES($1,$2,$3) ON CONFLICT(application_id) DO NOTHING',
      [app.id, result.merchant_id, JSON.stringify(['UPI', 'CARDS', 'NETBANKING'])],
    );
    await transition(tx, app, 'ACTIVATED', system);
    await audit(tx, app.id, 'MERCHANT_ID_CREATED', system, { merchant_id: result.merchant_id });
  });
}
async function onDead(tx: Tx, app: Application, job: Job) {
  await audit(tx, app.id, 'JOB_DEAD_LETTERED', system, {
    job_id: job.id,
    type: job.type,
    attempts: job.attempts,
  });
  if (job.type === 'INTAKE' && app.status === 'EXTRACTING') {
    await tx.query(
      "UPDATE documents SET extraction_status='FAILED' WHERE application_id=$1 AND is_active AND extraction_status='PENDING'",
      [app.id],
    );
    await raiseException(tx, app, 'EXTRACTION_FAILED', 'EXTRACTION_FAILED', {
      message: 'Document extraction exhausted retries. Replace the document or reprocess.',
    });
    await transition(tx, app, 'IN_REVIEW', system);
  } else if (job.type === 'DISPATCH_CHECK') {
    const {
      rows: [attempt],
    } = await tx.query(
      'SELECT a.*,c.check_type FROM check_attempts a JOIN verification_checks c ON c.id=a.check_id WHERE a.id=$1',
      [job.payload.attempt_id],
    );
    if (attempt?.status === 'QUEUED') {
      await changeAttempt(tx, attempt, 'DISPATCH_FAILED', { completed_at: new Date() });
      await tx.query(
        "UPDATE verification_checks SET status='ERROR',reason_code='PROVIDER_UNAVAILABLE' WHERE id=$1",
        [attempt.check_id],
      );
      await raiseException(
        tx,
        app,
        'PROVIDER_UNAVAILABLE',
        `PROVIDER_UNAVAILABLE:${attempt.check_type}`,
        { check_type: attempt.check_type },
      );
      await evaluate(tx, app);
    }
  } else if (job.type === 'PROVISION_MERCHANT' && app.status === 'APPROVED') {
    await raiseException(tx, app, 'PROVISIONING_FAILED', 'PROVISIONING_FAILED', {
      message: 'Merchant core exhausted retries; approval remains valid.',
    });
    await transition(tx, app, 'PROVISIONING_FAILED', system);
  }
}
export async function runJob(job: Job, handler?: () => Promise<void>, now = new Date()) {
  return correlationContext.run(job.payload.correlation_id ?? randomUUID(), () =>
    executeJob(job, handler, now),
  );
}
async function executeJob(job: Job, handler: (() => Promise<void>) | undefined, now: Date) {
  // Local vision can exceed a minute. Keep this worker's lease alive while it
  // processes or waits for the local GPU, without renewing a reclaimed lease.
  const heartbeat = setInterval(() => {
    void pool
      .query(
        "UPDATE jobs SET locked_at=now() WHERE id=$1 AND lease_token=$2 AND status='RUNNING'",
        [job.id, job.lease_token],
      )
      .catch(() => {});
  }, 15000);
  heartbeat.unref();
  // An abandoned final attempt still needs its dead-letter hook, without another external call.
  try {
    if (job.attempts > job.max_attempts) throw new Error('Job lease expired at retry limit');
    if (handler) await handler();
    else if (job.type === 'INTAKE') await intake(job.application_id);
    else if (job.type === 'DISPATCH_CHECK') await dispatch(job);
    else if (job.type === 'PROVISION_MERCHANT') await provision(job);
    else if (job.type === 'CHECK_TIMEOUT')
      await transaction(async (tx) => {
        const app = await lockApp(tx, job.application_id);
        const {
          rows: [a],
        } = await tx.query('SELECT * FROM check_attempts WHERE id=$1', [job.payload.attempt_id]);
        if (a) await timeoutAttempt(tx, app, a, now);
      });
    else throw new Error('Unknown job type');
    await pool.query(
      "UPDATE jobs SET status='SUCCEEDED',finished_at=now(),locked_at=NULL WHERE id=$1 AND lease_token=$2 AND status='RUNNING'",
      [job.id, job.lease_token],
    );
  } catch (error) {
    // Never persist raw provider/model errors, which may echo sensitive request bodies.
    const safeError =
      job.type === 'INTAKE'
        ? 'Extraction failed; check fixture support or model configuration'
        : `${job.type} failed; provider unavailable or response invalid`;
    await transaction(async (tx) => {
      const app = await lockApp(tx, job.application_id);
      const {
        rows: [current],
      } = await tx.query('SELECT * FROM jobs WHERE id=$1 FOR UPDATE', [job.id]);
      if (current.status !== 'RUNNING' || current.lease_token !== job.lease_token) return;
      const dead =
        job.attempts >= job.max_attempts ||
        (error instanceof ProviderHttpError && !error.retryable);
      await tx.query(
        'UPDATE jobs SET status=$2,last_error=$3,run_at=$4,locked_at=NULL,finished_at=$5 WHERE id=$1',
        [
          job.id,
          dead ? 'DEAD' : 'PENDING',
          safeError,
          new Date(now.getTime() + backoff(job.attempts)),
          dead ? now : null,
        ],
      );
      await audit(
        tx,
        app.id,
        job.type === 'PROVISION_MERCHANT' ? 'PROVISIONING_ATTEMPT_FAILED' : 'JOB_ATTEMPT_FAILED',
        system,
        { job_id: job.id, type: job.type, attempt: job.attempts, error: safeError },
      );
      if (dead) await onDead(tx, app, job);
    });
  } finally {
    clearInterval(heartbeat);
  }
}
export function startWorker() {
  let stopped = false;
  const active = new Set<Promise<void>>();
  const timer = setInterval(async () => {
    if (stopped || active.size >= 4) return;
    const task = (async () => {
      try {
        const job = await claimJob();
        if (job) await runJob(job);
      } catch {
        console.error('Worker database operation failed; retrying on next tick.');
      }
    })();
    active.add(task);
    void task.finally(() => active.delete(task));
  }, 250);
  return async () => {
    stopped = true;
    clearInterval(timer);
    await Promise.all(active);
  };
}
