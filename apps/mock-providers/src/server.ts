import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { config } from '../../api/src/config.js';
import { pool, transaction, type Tx } from '../../api/src/db.js';
import { signature } from '../../api/src/crypto.js';
import { scenarioSchema, type Scenario } from '../../../packages/shared/src/index.js';

async function consume(tx: Tx, target: string, appId: string): Promise<Scenario> {
  const {
    rows: [scenario],
  } = await tx.query(
    `SELECT * FROM mock_scenarios WHERE remaining>0 AND rule->>'target'=$1 AND (rule->>'application_id' IS NULL OR rule->>'application_id'=$2) ORDER BY (rule->>'application_id' IS NOT NULL) DESC,created_at DESC LIMIT 1 FOR UPDATE`,
    [target, appId],
  );
  if (!scenario) return scenarioSchema.parse({ target, behavior: 'SUCCESS', delay_ms: 2000 });
  await tx.query('UPDATE mock_scenarios SET remaining=remaining-1 WHERE id=$1', [scenario.id]);
  return scenario.rule;
}
export async function buildMockServer() {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (req, reply) => {
    if (req.url !== '/health' && req.headers['x-mock-secret'] !== config.adminSecret)
      return reply.code(401).send({ error: 'Invalid simulator secret' });
  });
  app.setErrorHandler((error, _req, reply) =>
    reply
      .code(error instanceof z.ZodError ? 400 : 500)
      .send({ error: 'Invalid simulator request or database failure' }),
  );
  app.get('/health', async () => ({ status: 'ok' }));
  app.put('/mock/admin/scenarios', async (req) => {
    const rule = scenarioSchema.parse(req.body);
    const {
      rows: [row],
    } = await pool.query('INSERT INTO mock_scenarios(rule,remaining) VALUES($1,$2) RETURNING *', [
      JSON.stringify(rule),
      rule.times,
    ]);
    return row;
  });
  app.get('/mock/admin/scenarios', async () => ({
    items: (await pool.query('SELECT * FROM mock_scenarios ORDER BY created_at DESC LIMIT 200'))
      .rows,
  }));
  app.delete('/mock/admin/scenarios', async () => {
    await pool.query('DELETE FROM mock_scenarios');
    return { ok: true };
  });
  for (const provider of ['pan', 'gst', 'bank', 'risk'])
    app.post(
      `/mock/${provider}/${provider === 'risk' ? 'assess' : 'verify'}`,
      async (req, reply) => {
        const body = z
          .object({
            application_id: z.string().uuid(),
            client_reference_id: z.string().uuid(),
            callback_url: z.string().url(),
            subject: z.unknown(),
          })
          .strict()
          .parse(req.body);
        if (req.headers['idempotency-key'] !== body.client_reference_id)
          return reply.code(400).send({ error: 'Idempotency key must equal attempt ID' });
        if (body.callback_url !== `${config.apiUrl}/api/v1/webhooks/providers/${provider}`)
          return reply.code(400).send({ error: 'Callback URL is not allowlisted' });
        const result = await transaction(async (tx) => {
          await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
            body.client_reference_id,
          ]);
          const {
            rows: [existing],
          } = await tx.query('SELECT * FROM mock_requests WHERE id=$1', [body.client_reference_id]);
          if (existing) return existing.response;
          const scenario = await consume(tx, provider, body.application_id);
          if (scenario.behavior === 'HTTP_503') return { unavailable: true };
          const provider_request_id = `${provider}_${randomUUID()}`,
            band =
              scenario.behavior === 'RISK_BAND'
                ? (scenario.band ?? 'MEDIUM')
                : scenario.behavior === 'FAIL'
                  ? 'HIGH'
                  : 'LOW';
          const callback = {
            event_id: `evt_${randomUUID()}`,
            client_reference_id: body.client_reference_id,
            provider_request_id,
            status:
              provider === 'risk'
                ? 'ASSESSED'
                : scenario.behavior === 'FAIL'
                  ? 'NOT_VERIFIED'
                  : 'VERIFIED',
            reason_code: scenario.behavior === 'FAIL' ? scenario.reason_code : undefined,
            details:
              provider === 'risk'
                ? { band, score: band === 'LOW' ? 10 : band === 'MEDIUM' ? 45 : 90, reasons: [] }
                : {},
            occurred_at: new Date().toISOString(),
          };
          const response = { provider_request_id };
          const delay =
            scenario.behavior === 'LATE_CALLBACK'
              ? Math.max(18000, scenario.delay_ms)
              : scenario.delay_ms;
          await tx.query(
            'INSERT INTO mock_requests(id,provider,application_id,response,callback,callback_url,run_at,remaining_deliveries) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
            [
              body.client_reference_id,
              provider,
              body.application_id,
              JSON.stringify(response),
              JSON.stringify(callback),
              body.callback_url,
              new Date(Date.now() + delay),
              scenario.behavior === 'NO_CALLBACK'
                ? 0
                : scenario.behavior === 'DUPLICATE_CALLBACK'
                  ? scenario.repeats
                  : 1,
            ],
          );
          return response;
        });
        if ('unavailable' in result) return reply.code(503).send({ error: 'Simulated outage' });
        reply.code(202);
        return result;
      },
    );
  app.post('/mock/merchant-core/merchants', async (req, reply) => {
    const body = z
      .object({
        application_id: z.string().uuid(),
        legal_name: z.string(),
        capabilities: z.array(z.string()),
      })
      .strict()
      .parse(req.body);
    if (req.headers['idempotency-key'] !== body.application_id)
      return reply.code(400).send({ error: 'Idempotency key must equal application ID' });
    const result = await transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `merchant:${body.application_id}`,
      ]);
      const {
        rows: [prior],
      } = await tx.query('SELECT merchant_id FROM mock_merchants WHERE application_id=$1', [
        body.application_id,
      ]);
      if (prior) return prior;
      const scenario = await consume(tx, 'merchant-core', body.application_id);
      if (['HTTP_503', 'FAIL'].includes(scenario.behavior)) return { unavailable: true };
      const merchant_id = `MID${body.application_id.replaceAll('-', '').toUpperCase()}`;
      await tx.query('INSERT INTO mock_merchants(application_id,merchant_id) VALUES($1,$2)', [
        body.application_id,
        merchant_id,
      ]);
      return { merchant_id };
    });
    if ('unavailable' in result)
      return reply.code(503).send({ error: 'Simulated merchant-core outage' });
    reply.code(201);
    return result;
  });
  return app;
}
export function startDeliveries() {
  let busy = false,
    stopped = false;
  let active = Promise.resolve();
  const timer = setInterval(() => {
    if (busy || stopped) return;
    busy = true;
    active = (async () => {
      try {
        const { rows } = await pool.query(
          'SELECT * FROM mock_requests WHERE remaining_deliveries>0 AND delivery_attempts<12 AND run_at<=now() ORDER BY run_at LIMIT 20',
        );
        for (const request of rows) {
          const body = JSON.stringify(request.callback),
            timestamp = String(Math.floor(Date.now() / 1000));
          let ok = false;
          try {
            const response = await fetch(request.callback_url, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'x-provider-timestamp': timestamp,
                'x-provider-signature': signature(request.provider, timestamp, body),
              },
              body,
              signal: AbortSignal.timeout(5000),
            });
            ok = response.ok;
          } catch {}
          await pool.query(
            "UPDATE mock_requests SET remaining_deliveries=remaining_deliveries-$2,delivery_attempts=delivery_attempts+1,run_at=now()+interval '1 second' WHERE id=$1",
            [request.id, ok ? 1 : 0],
          );
        }
      } catch {
        console.error('Simulator delivery database operation failed.');
      } finally {
        busy = false;
      }
    })();
  }, 200);
  return async () => {
    stopped = true;
    clearInterval(timer);
    await active;
  };
}
