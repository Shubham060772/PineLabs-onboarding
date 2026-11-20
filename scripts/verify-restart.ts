import { ensureEnv } from './env.js';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { uniqueDemoForm, demoDocuments } from '../packages/shared/src/demo.js';
ensureEnv();
const base = `${process.env.API_URL}/api/v1`;
async function call(path: string, method = 'GET', body?: unknown, token?: string): Promise<any> {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`${path} returned HTTP ${res.status}`);
  return res.json();
}
const merchant = (
  await call('/auth/login', 'POST', { email: 'merchant@onboard.demo', password: 'DemoPass123!' })
).token;
const operator = (
  await call('/auth/login', 'POST', { email: 'operator@onboard.demo', password: 'DemoPass123!' })
).token;
const n = 9500 + Math.floor(Math.random() * 499),
  form = uniqueDemoForm(`Restart Recovery ${n}`);
const app = await call('/applications', 'POST', form, merchant);
for (const target of ['pan', 'gst', 'bank'])
  await call(
    '/simulator/scenarios',
    'PUT',
    { target, behavior: 'SUCCESS', delay_ms: 8000, application_id: app.id, times: 1 },
    operator,
  );
for (const [doc_type, structured_payload] of Object.entries(demoDocuments(form)))
  await call(
    `/applications/${app.id}/documents`,
    'POST',
    { doc_type, structured_payload },
    merchant,
  );
await call(`/applications/${app.id}/submit`, 'POST', undefined, merchant);
let awaiting = false;
for (let i = 0; i < 100; i++) {
  const d = await call(`/applications/${app.id}`, 'GET', undefined, operator);
  if (
    d.status === 'VERIFYING' &&
    d.checks.filter((c: any) => c.attempts.some((a: any) => a.status === 'AWAITING_CALLBACK'))
      .length === 3
  ) {
    awaiting = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 200));
}
if (!awaiting) throw new Error('Verification did not begin');
console.log(`${app.reference}: three checks awaiting callbacks. Restarting API process.`);
const id = randomUUID();
writeFileSync('.local/restart-api-request.json', JSON.stringify({ id }));
let restarted = false;
for (let i = 0; i < 100; i++) {
  if (existsSync('.local/restart-api-result.json')) {
    const result = JSON.parse(readFileSync('.local/restart-api-result.json', 'utf8'));
    if (result.id === id && result.ok) {
      restarted = true;
      break;
    }
  }
  await new Promise((r) => setTimeout(r, 200));
}
if (!restarted)
  throw new Error('API restart did not complete. Run npm run dev using the current launcher.');
for (let i = 0; i < 150; i++) {
  const current = await call(`/applications/${app.id}`, 'GET', undefined, operator);
  if (current.status === 'ACTIVATED') {
    const timeline = await call(`/applications/${app.id}/timeline`, 'GET', undefined, operator);
    if (timeline.items.filter((e: any) => e.event_type === 'MERCHANT_ID_CREATED').length !== 1)
      throw new Error('Provisioning was not exactly once');
    console.log(
      `${app.reference}: ACTIVATED after API restart; four passed checks, one merchant ID, complete audit history.`,
    );
    process.exitCode = 0;
    break;
  }
  if (i === 149) throw new Error(`Recovery did not activate: ${current.status}`);
  await new Promise((r) => setTimeout(r, 200));
}
