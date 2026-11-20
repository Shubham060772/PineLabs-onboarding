import Fastify, { type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { config } from './config.js';
import { pool, transaction, lockApp, audit, correlationContext } from './db.js';
import { sanitize, verifySignature } from './crypto.js';
import { receiveCallback } from './workflow.js';
import {
  AppError,
  APP_STATUSES,
  CHECK_TYPES,
  DOC_TYPES,
  bankSchema,
  callbackSchema,
  formSchema,
  infoItemSchema,
  noteSchema,
  scenarioSchema,
  structuredSchema,
  type Actor,
  type User,
} from '../../../packages/shared/src/index.js';
import * as applications from './applications.js';
declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: User;
    user: User;
  }
}
function actor(req: FastifyRequest): Actor {
  return { type: req.user.role, id: req.user.id, correlation_id: req.id };
}
const idParam = z.object({ id: z.string().uuid() });
const idOf = (req: FastifyRequest) => idParam.parse(req.params).id;
const operator = (req: FastifyRequest) => {
  if (req.user.role !== 'OPERATOR') throw new AppError('FORBIDDEN', 'Operator role required', 403);
};
async function mockCall(method: string, body?: unknown) {
  const result = await fetch(`${config.mockUrl}/mock/admin/scenarios`, {
    method,
    headers: {
      'x-mock-secret': config.adminSecret,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  if (!result.ok) throw new AppError('SIMULATOR_UNAVAILABLE', 'Simulator request failed', 502);
  return result.json();
}
export async function buildServer(logging = false) {
  const app = Fastify({
    logger: logging
      ? {
          level: 'info',
          redact: [
            'req.headers.authorization',
            'req.headers.cookie',
            'password',
            'pan',
            'gstin',
            'account_number',
            'body',
            'req.body',
          ],
          serializers: {
            req(req) {
              return { method: req.method, url: sanitize(req.url?.split('?')[0]), id: req.id };
            },
            err(error) {
              return { type: error.name, message: 'Request failed', stack: '', code: error.code };
            },
          },
        }
      : false,
    bodyLimit: 1024 * 1024,
    requestIdHeader: false,
    genReqId(req) {
      const supplied = req.headers['x-request-id'];
      return typeof supplied === 'string' &&
        /^[a-zA-Z0-9_-]{1,80}$/.test(supplied) &&
        sanitize(supplied) === supplied
        ? supplied
        : randomUUID();
    },
  });
  app.addHook('onRequest', (req, reply, done) => {
    reply.header('x-request-id', req.id);
    correlationContext.run(req.id, done);
  });
  app.setNotFoundHandler((req, reply) =>
    reply
      .code(404)
      .send({ error: { code: 'NOT_FOUND', message: 'Route not found', correlation_id: req.id } }),
  );
  await app.register(cors, { origin: config.webOrigin });
  await app.register(jwt, {
    secret: config.jwtSecret,
    sign: { expiresIn: '8h', algorithm: 'HS256' },
    verify: { algorithms: ['HS256'], cache: false },
  });
  await app.register(multipart, {
    limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 12, parts: 14 },
  });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof z.ZodError)
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Please check the supplied fields',
          details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          correlation_id: req.id,
        },
      });
    if (error instanceof AppError)
      return reply.code(error.status).send({
        error: {
          code: error.code,
          message: error.message,
          details: sanitize(error.details),
          correlation_id: req.id,
        },
      });
    const e = error as any;
    const status =
      e.statusCode === 413 || e.code === 'FST_REQ_FILE_TOO_LARGE'
        ? 413
        : e.statusCode === 429
          ? 429
          : e.statusCode === 415
            ? 415
            : e.statusCode === 400
              ? 400
              : 500;
    req.log.error({ err: error }, 'Request failed');
    reply.code(status).send({
      error: {
        code:
          status === 413
            ? 'FILE_TOO_LARGE'
            : status === 429
              ? 'RATE_LIMITED'
              : status === 415
                ? 'UNSUPPORTED_MEDIA_TYPE'
                : status === 400
                  ? 'VALIDATION_ERROR'
                  : 'INTERNAL_ERROR',
        message:
          status === 413
            ? 'Documents must be at most 5 MB'
            : status === 429
              ? 'Too many requests'
              : status === 415
                ? 'Unsupported request content type'
                : status === 400
                  ? 'Invalid request body'
                  : 'The request could not be completed',
        correlation_id: req.id,
      },
    });
  });
  app.get('/health', async () => {
    await pool.query('SELECT 1');
    return { status: 'ok', extractor: config.extractor };
  });
  app.post(
    '/api/v1/auth/login',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req) => {
      const body = z
        .object({ email: z.string().email(), password: z.string().min(1).max(200) })
        .strict()
        .parse(req.body);
      const {
        rows: [row],
      } = await pool.query('SELECT * FROM users WHERE email=$1', [body.email.toLowerCase()]);
      if (!row || !(await bcrypt.compare(body.password, row.password_hash)))
        throw new AppError('INVALID_CREDENTIALS', 'Invalid email or password', 401);
      const user: User = {
        id: row.id,
        email: row.email,
        role: row.role,
        display_name: row.display_name,
      };
      return { token: app.jwt.sign(user), user };
    },
  );
  await app.register(async (webhooks) => {
    webhooks.removeContentTypeParser('application/json');
    webhooks.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) =>
      done(null, body),
    );
    webhooks.post('/api/v1/webhooks/providers/:provider', async (req) => {
      const { provider } = z
        .object({ provider: z.enum(['pan', 'gst', 'bank', 'risk']) })
        .parse(req.params);
      const raw = req.body as string,
        timestamp = String(req.headers['x-provider-timestamp'] ?? ''),
        sig = String(req.headers['x-provider-signature'] ?? '');
      if (!verifySignature(provider, timestamp, raw, sig))
        throw new AppError('INVALID_SIGNATURE', 'Invalid or expired provider signature', 401);
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        throw new AppError('VALIDATION_ERROR', 'Invalid callback JSON', 400);
      }
      return receiveCallback(provider, callbackSchema.parse(json));
    });
  });
  await app.register(
    async (api) => {
      api.addHook('preHandler', async (req) => {
        try {
          await req.jwtVerify();
          z.string().uuid().parse(req.user.id);
        } catch {
          throw new AppError('UNAUTHENTICATED', 'Sign in to continue', 401);
        }
        const {
          rows: [current],
        } = await pool.query('SELECT id,email,role,display_name FROM users WHERE id=$1', [
          req.user.id,
        ]);
        if (!current) throw new AppError('UNAUTHENTICATED', 'Sign in to continue', 401);
        req.user = current;
      });
      api.get('/auth/me', async (req) => req.user);
      api.get('/extraction/status', async () => {
        let ready = true;
        if (config.extractor === 'local') {
          try {
            ready = (
              await fetch(config.localModelUrl + '/models', { signal: AbortSignal.timeout(2000) })
            ).ok;
          } catch {
            ready = false;
          }
        } else if (config.extractor === 'llm') ready = !!process.env.ANTHROPIC_API_KEY;
        return {
          engine: config.extractor,
          model:
            config.extractor === 'local'
              ? config.localModel
              : config.extractor === 'llm'
                ? config.model
                : null,
          ready,
          provider_verification: 'SIMULATED',
          max_pdf_pages: config.extractor === 'local' ? 3 : null,
        };
      });
      api.get('/applications', async (req) => {
        const q = z
          .object({
            status: z.enum(APP_STATUSES).optional(),
            q: z.string().max(100).optional(),
            has_open_exceptions: z.enum(['true', 'false']).optional(),
            page: z.coerce.number().int().min(1).default(1),
            page_size: z.coerce.number().int().min(1).max(100).default(20),
          })
          .parse(req.query);
        const args: any[] = [];
        const where: string[] = [];
        const param = (v: any) => {
          args.push(v);
          return `$${args.length}`;
        };
        if (req.user.role === 'MERCHANT') where.push(`owner_user_id=${param(req.user.id)}`);
        if (q.status) where.push(`status=${param(q.status)}`);
        if (q.q) {
          const p = param(`%${q.q}%`);
          where.push(`(legal_name ILIKE ${p} OR reference ILIKE ${p})`);
        }
        if (q.has_open_exceptions)
          where.push(
            `${q.has_open_exceptions === 'false' ? 'NOT ' : ''}EXISTS(SELECT 1 FROM application_exceptions e WHERE e.application_id=a.id AND e.status='OPEN')`,
          );
        const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const {
          rows: [total],
        } = await pool.query(`SELECT count(*)::int AS n FROM applications a ${filter}`, args);
        const { rows } = await pool.query(
          `SELECT a.*,(SELECT count(*) FROM application_exceptions e WHERE e.application_id=a.id AND e.status='OPEN') AS open_exceptions FROM applications a ${filter} ORDER BY created_at DESC LIMIT ${param(q.page_size)} OFFSET ${param((q.page - 1) * q.page_size)}`,
          args,
        );
        return { items: rows.map(applications.summary), total: total.n };
      });
      api.post('/applications', async (req, reply) => {
        const key = req.headers['idempotency-key'];
        if (key !== undefined) z.string().min(1).max(100).parse(key);
        const result = await applications.createApplication(
          formSchema.parse(req.body),
          req.user,
          actor(req),
          key as string | undefined,
        );
        reply.code(201);
        return result;
      });
      api.get('/applications/:id', async (req) => applications.detail(idOf(req), req.user));
      api.patch('/applications/:id', async (req) =>
        applications.editApplication(
          idOf(req),
          formSchema.partial().parse(req.body),
          req.user,
          actor(req),
        ),
      );
      api.post('/applications/:id/submit', async (req, reply) => {
        const result = await applications.submit(idOf(req), req.user, actor(req));
        reply.code(202);
        return result;
      });
      api.post('/applications/:id/documents', async (req, reply) => {
        let input: applications.Upload;
        if (req.isMultipart()) {
          const fields: Record<string, string> = {};
          let file: Buffer | undefined;
          for await (const part of req.parts()) {
            if (part.type === 'file') {
              file = await part.toBuffer();
              if (part.file.truncated)
                throw new AppError('FILE_TOO_LARGE', 'Document exceeds 5 MB', 413);
            } else fields[part.fieldname] = String(part.value);
          }
          if (!file) throw new AppError('VALIDATION_ERROR', 'Attach a document file', 400);
          input = { doc_type: z.enum(DOC_TYPES).parse(fields.doc_type), file };
        } else input = structuredSchema.parse(req.body);
        const result = await applications.uploadDocument(idOf(req), input, req.user, actor(req));
        reply.code(201);
        return result;
      });
      api.get('/applications/:id/documents/:docId/content', async (req, reply) => {
        const p = z.object({ id: z.string().uuid(), docId: z.string().uuid() }).parse(req.params);
        const result = await applications.documentContent(p.id, p.docId, req.user, actor(req));
        return reply
          .header('cache-control', 'no-store')
          .header('x-content-type-options', 'nosniff')
          .header('content-security-policy', "default-src 'none'; sandbox")
          .type(result.mime)
          .send(result.content);
      });
      api.put('/applications/:id/bank-account', async (req, reply) => {
        let bank: any, proof: applications.Upload | undefined;
        if (req.isMultipart()) {
          const fields: Record<string, string> = {};
          for await (const part of req.parts()) {
            if (part.type === 'file')
              proof = { doc_type: 'BANK_PROOF', file: await part.toBuffer() };
            else fields[part.fieldname] = String(part.value);
          }
          bank = bankSchema.parse(fields);
        } else {
          const body = bankSchema
            .extend({ bank_proof: z.record(z.string(), z.string().max(300)).optional() })
            .parse(req.body);
          const { bank_proof, ...rest } = body;
          bank = rest;
          if (bank_proof) proof = { doc_type: 'BANK_PROOF', structured_payload: bank_proof };
        }
        const result = await applications.changeBank(idOf(req), bank, proof, req.user, actor(req));
        reply.code(202);
        return result;
      });
      api.get('/applications/:id/timeline', async (req) => {
        const id = idOf(req),
          { after_id } = z
            .object({ after_id: z.coerce.number().int().min(0).default(0) })
            .parse(req.query);
        return transaction(async (tx) => {
          const app = await lockApp(tx, id);
          applications.authorize(app, req.user);
          const { rows } = await tx.query(
            `SELECT * FROM audit_events WHERE application_id=$1 AND id>$2 ${req.user.role === 'MERCHANT' ? "AND event_type IN ('STATE_CHANGED','INFORMATION_REQUESTED','MERCHANT_ID_CREATED')" : ''} ORDER BY id LIMIT 500`,
            [id, after_id],
          );
          return { items: sanitize(rows) };
        });
      });
      for (const action of ['approve', 'reject', 'request-info', 'reprocess'])
        api.post(`/applications/:id/${action}`, async (req) => {
          operator(req);
          const schema =
            action === 'reject'
              ? noteSchema.extend({ reason_code: z.string().regex(/^[A-Z0-9_]{1,80}$/) })
              : action === 'request-info'
                ? noteSchema.extend({ items: z.array(infoItemSchema).min(1).max(20) })
                : noteSchema;
          return applications.operatorAction(
            idOf(req),
            action,
            schema.strict().parse(req.body),
            req.user,
            actor(req),
          );
        });
      api.post('/applications/:id/provisioning/retry', async (req, reply) => {
        operator(req);
        const result = await applications.operatorAction(
          idOf(req),
          'retry',
          noteSchema.strict().parse(req.body),
          req.user,
          actor(req),
        );
        reply.code(202);
        return result;
      });
      api.post('/applications/:id/checks/:checkType/rerun', async (req, reply) => {
        operator(req);
        const p = idParam.extend({ checkType: z.enum(CHECK_TYPES) }).parse(req.params);
        const result = await applications.operatorAction(
          p.id,
          'rerun',
          noteSchema.strict().parse(req.body),
          req.user,
          actor(req),
          p.checkType,
        );
        reply.code(202);
        return result;
      });
      api.post('/applications/:id/exceptions/:exId/resolve', async (req) => {
        operator(req);
        const p = idParam.extend({ exId: z.string().uuid() }).parse(req.params);
        return applications.operatorAction(
          p.id,
          'resolve',
          noteSchema
            .extend({ resolution: z.enum(['ACCEPTED', 'FALSE_POSITIVE']) })
            .strict()
            .parse(req.body),
          req.user,
          actor(req),
          p.exId,
        );
      });
      api.get('/review-queue', async (req) => {
        operator(req);
        const q = z.object({ exception_type: z.string().max(80).optional() }).parse(req.query);
        const { rows } = await pool.query(
          `SELECT a.*,EXTRACT(EPOCH FROM now()-a.status_changed_at)::int AS waiting_seconds FROM applications a WHERE status='IN_REVIEW' AND ($1::text IS NULL OR EXISTS(SELECT 1 FROM application_exceptions e WHERE e.application_id=a.id AND e.status='OPEN' AND e.type=$1)) ORDER BY status_changed_at`,
          [q.exception_type ?? null],
        );
        const items = [];
        for (const a of rows) {
          const { rows: e } = await pool.query(
            "SELECT id,type,details FROM application_exceptions WHERE application_id=$1 AND status='OPEN'",
            [a.id],
          );
          items.push({
            application: applications.summary(a),
            waiting_seconds: a.waiting_seconds,
            open_exceptions: e,
          });
        }
        return sanitize({ items });
      });
      api.get('/config/check-policies', async (req) => {
        operator(req);
        return (await pool.query('SELECT * FROM check_policies ORDER BY check_type')).rows;
      });
      api.get('/dead-letters', async (req) => {
        operator(req);
        return {
          jobs: (
            await pool.query(
              "SELECT id,type,application_id,attempts,last_error,finished_at FROM jobs WHERE status='DEAD' ORDER BY id DESC LIMIT 200",
            )
          ).rows,
          webhook_events: (
            await pool.query(
              "SELECT id,provider,event_id,outcome,first_received_at FROM webhook_events WHERE outcome='UNMATCHED' ORDER BY first_received_at DESC LIMIT 200",
            )
          ).rows,
        };
      });
      api.get('/metrics/summary', async (req) => {
        operator(req);
        const { window } = z
          .object({ window: z.enum(['24h', '7d']).default('24h') })
          .parse(req.query);
        const since = new Date(Date.now() - (window === '24h' ? 24 : 168) * 3600000);
        const { rows: counts } = await pool.query(
          'SELECT status,count(*)::int AS count FROM applications WHERE created_at>=$1 GROUP BY status',
          [since],
        );
        const {
          rows: [rates],
        } = await pool.query(
          `SELECT count(*) FILTER(WHERE approved_at IS NOT NULL OR status='REJECTED')::float AS decided,count(*) FILTER(WHERE approved_at IS NOT NULL AND approved_by IS NULL)::float AS automatic,count(*) FILTER(WHERE submitted_at IS NOT NULL)::float AS submitted,count(*) FILTER(WHERE submitted_at IS NOT NULL AND EXISTS(SELECT 1 FROM application_exceptions e WHERE e.application_id=a.id))::float AS exception_apps FROM applications a WHERE submitted_at>=$1`,
          [since],
        );
        const { rows: durations } = await pool.query(
          `WITH events AS (SELECT to_status AS state,created_at,lead(created_at) OVER(PARTITION BY application_id ORDER BY id) AS next_at FROM audit_events WHERE event_type='STATE_CHANGED') SELECT state,avg(EXTRACT(EPOCH FROM next_at-created_at))::float AS avg,percentile_cont(0.5) WITHIN GROUP(ORDER BY EXTRACT(EPOCH FROM next_at-created_at))::float AS p50 FROM events WHERE next_at IS NOT NULL AND created_at>=$1 GROUP BY state`,
          [since],
        );
        const { rows: checks } = await pool.query(
          'SELECT check_type,c.status,count(*)::int AS count FROM verification_checks c JOIN applications a ON a.id=c.application_id WHERE a.submitted_at>=$1 GROUP BY check_type,c.status',
          [since],
        );
        const { rows: callbacks } = await pool.query(
          'SELECT outcome,count(*)::int AS count,sum(delivery_count-1)::int AS duplicates FROM webhook_events WHERE first_received_at>=$1 GROUP BY outcome',
          [since],
        );
        const {
          rows: [queue],
        } = await pool.query(
          "SELECT count(*)::int AS size,COALESCE(max(EXTRACT(EPOCH FROM now()-status_changed_at)),0)::int AS oldest_waiting_seconds FROM applications WHERE status='IN_REVIEW'",
        );
        return {
          window,
          counts_by_status: Object.fromEntries(counts.map((c) => [c.status, c.count])),
          straight_through_rate: rates.decided ? rates.automatic / rates.decided : 0,
          exception_rate: rates.submitted ? rates.exception_apps / rates.submitted : 0,
          time_in_state_seconds: Object.fromEntries(
            durations.map((d) => [d.state, { avg: d.avg, p50: d.p50 }]),
          ),
          checks,
          callbacks,
          duplicate_deliveries: callbacks.reduce((n, c) => n + c.duplicates, 0),
          dead_jobs: (
            await pool.query(
              "SELECT count(*)::int AS n FROM jobs WHERE status='DEAD' AND created_at>=$1",
              [since],
            )
          ).rows[0].n,
          review_queue: queue,
        };
      });
      for (const method of ['GET', 'PUT', 'DELETE'] as const)
        api.route({
          method,
          url: '/simulator/scenarios',
          handler: async (req) => {
            operator(req);
            if (!config.demo) throw new AppError('NOT_FOUND', 'Demo simulator is disabled', 404);
            return mockCall(method, method === 'PUT' ? scenarioSchema.parse(req.body) : undefined);
          },
        });
    },
    { prefix: '/api/v1' },
  );
  return app;
}
