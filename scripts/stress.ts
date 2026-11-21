import { ensureEnv } from './env.js';
import pg from 'pg';
import { request as httpRequest, Agent } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { uniqueDemoForm, demoDocuments } from '../packages/shared/src/demo.js';

ensureEnv();
const run = Date.now();
const database = `onboard_stress_${run}`;
assert.match(database, /^onboard_stress_\d+$/);
const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
await admin.connect();
await admin.query(`CREATE DATABASE ${database}`);
await admin.end();
const url = new URL(process.env.DATABASE_URL!);
url.pathname = '/' + database;
Object.assign(process.env, {
  DATABASE_URL: url.toString(),
  API_PORT: '3101',
  MOCK_PORT: '3102',
  API_URL: 'http://127.0.0.1:3101',
  MOCK_URL: 'http://127.0.0.1:3102',
  WEB_ORIGIN: 'http://localhost:5174',
  EXTRACTOR: 'fixture',
  STORAGE_DIR: `.local/stress-storage/${run}`,
  AUTO_SEED_DEMO: 'false',
});
const { migrate } = await import('./migrate.js');
await migrate();
const { seedUsers } = await import('./seed.js');
await seedUsers();
const { pool } = await import('../apps/api/src/db.js');
const { buildServer } = await import('../apps/api/src/server.js');
const { buildMockServer, startDeliveries } = await import('../apps/mock-providers/src/server.js');
const { startWorker } = await import('../apps/api/src/jobs.js');
const { signature, decrypt } = await import('../apps/api/src/crypto.js');
const api = await buildServer(),
  mock = await buildMockServer();
await api.listen({ port: 3101, host: '127.0.0.1' });
await mock.listen({ port: 3102, host: '127.0.0.1' });
const stopWorker = startWorker(),
  stopDeliveries = startDeliveries();
const agent = new Agent({ keepAlive: true, maxSockets: 64 });
type Result = { status: number; data: any; ms: number };
const metrics: Record<string, Result[]> = {};
function request(
  phase: string,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    token?: string;
    headers?: Record<string, string>;
    ip?: number;
  } = {},
): Promise<Result> {
  const started = performance.now();
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      'http://127.0.0.1:3101' + path,
      {
        method: options.method ?? 'GET',
        agent,
        localAddress: `127.0.0.${options.ip ?? 2}`,
        headers: {
          ...(options.token ? { authorization: 'Bearer ' + options.token } : {}),
          ...(payload ? { 'content-type': 'application/json' } : {}),
          ...options.headers,
        },
      },
      (res) => {
        const parts: Buffer[] = [];
        res.on('data', (part) => parts.push(part));
        res.on('end', () => {
          let data: any;
          try {
            data = JSON.parse(Buffer.concat(parts).toString());
          } catch {
            data = {};
          }
          const result = {
            status: res.statusCode!,
            data,
            ms: Math.round((performance.now() - started) * 100) / 100,
          };
          (metrics[phase] ??= []).push(result);
          resolve(result);
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Stress request timed out')));
    req.end(payload);
  });
}
async function parallel(count: number, concurrency: number, fn: (i: number) => Promise<unknown>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (;;) {
        const i = next++;
        if (i >= count) return;
        await fn(i);
      }
    }),
  );
}
const invariants: Record<string, boolean> = {};
let failure: string | undefined;
try {
  if (!process.argv.includes('--browser-only')) {
    const m = await request('auth', '/api/v1/auth/login', {
      method: 'POST',
      body: { email: 'merchant@onboard.demo', password: 'DemoPass123!' },
    });
    const o = await request('auth', '/api/v1/auth/login', {
      method: 'POST',
      body: { email: 'other@onboard.demo', password: 'DemoPass123!' },
    });
    assert.equal(m.status, 200);
    assert.equal(o.status, 200);
    const token = m.data.token;
    const form = uniqueDemoForm('Stress Idempotency Store');
    const key = randomUUID();
    const ids = new Set<string>();
    await parallel(60, 30, async () => {
      const r = await request('idempotent_create', '/api/v1/applications', {
        method: 'POST',
        body: form,
        token,
        headers: { 'idempotency-key': key },
      });
      assert.equal(r.status, 201);
      ids.add(r.data.id);
    });
    assert.equal(ids.size, 1);
    invariants.concurrent_create_once = true;
    const same = [...ids][0];
    await parallel(20, 10, async () => {
      const r = await request('upload_race', `/api/v1/applications/${same}/documents`, {
        method: 'POST',
        body: { doc_type: 'PAN_CARD', structured_payload: demoDocuments(form).PAN_CARD },
        token,
      });
      assert.equal(r.status, 201);
    });
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int n FROM documents WHERE application_id=$1 AND is_active',
          [same],
        )
      ).rows[0].n,
      1,
    );
    invariants.one_active_document_per_slot = true;
    const denied = await request('authorization', `/api/v1/applications/${same}`, {
      token: o.data.token,
    });
    assert.equal(denied.status, 404);
    invariants.cross_owner_denied = true;
    const invalidCases = [
      { path: '/api/v1/applications/not-a-uuid', status: 400 },
      { path: '/api/v1/applications?page=-1', status: 400 },
      { path: '/api/v1/applications?page_size=1000000', status: 400 },
      { path: `/api/v1/applications/${randomUUID()}`, status: 404 },
      { path: '/api/v1/applications', status: 400, method: 'POST', body: { legal_name: '' } },
      {
        path: '/api/v1/applications',
        status: 415,
        method: 'POST',
        body: {},
        headers: { 'content-type': 'application/xml' },
      },
    ];
    await parallel(60, 10, async (i) => {
      const invalid = invalidCases[i % invalidCases.length];
      assert.equal(
        (await request('invalid_inputs', invalid.path, { ...invalid, token, ip: 180 + (i % 10) }))
          .status,
        invalid.status,
      );
    });
    invariants.invalid_input_burst_has_no_server_errors = true;
    const apps: string[] = [];
    await parallel(30, 10, async (i) => {
      const f = uniqueDemoForm(`Stress Store ${run} ${i}`);
      const ip = 10 + i;
      const created = await request('workflow_create', '/api/v1/applications', {
        method: 'POST',
        body: f,
        token,
        ip,
      });
      assert.equal(created.status, 201);
      const id = created.data.id;
      apps[i] = id;
      if (i === 0)
        await pool.query('INSERT INTO mock_scenarios(rule,remaining) VALUES($1,1)', [
          JSON.stringify({
            target: 'pan',
            behavior: 'NO_CALLBACK',
            application_id: id,
            delay_ms: 200,
            times: 1,
          }),
        ]);
      for (const [doc_type, structured_payload] of Object.entries(demoDocuments(f)))
        assert.equal(
          (
            await request('workflow_upload', `/api/v1/applications/${id}/documents`, {
              method: 'POST',
              body: { doc_type, structured_payload },
              token,
              ip,
            })
          ).status,
          201,
        );
      assert.equal(
        (
          await request('workflow_submit', `/api/v1/applications/${id}/submit`, {
            method: 'POST',
            token,
            ip,
          })
        ).status,
        202,
      );
    });
    console.log('Submitted 30 isolated applications concurrently.');
    await parallel(20, 20, async (i) => {
      assert.equal(
        (
          await request('repeat_submit', `/api/v1/applications/${apps[1]}/submit`, {
            method: 'POST',
            token,
            ip: 50 + i,
          })
        ).status,
        409,
      );
    });
    invariants.repeat_submit_rejected = true;
    await parallel(1000, 50, async (i) => {
      const endpoint =
        i % 3 === 0
          ? '/api/v1/applications?page_size=100'
          : i % 3 === 1
            ? `/api/v1/applications/${apps[i % apps.length]}`
            : `/api/v1/applications/${apps[i % apps.length]}/timeline`;
      assert.equal(
        (await request('read_load', endpoint, { token, ip: 50 + (i % 50) })).status,
        200,
      );
    });
    console.log('Completed 1,000 reads at concurrency 50.');
    let attempt: any;
    for (let n = 0; n < 100; n++) {
      attempt = (
        await pool.query(
          "SELECT a.* FROM check_attempts a JOIN verification_checks c ON c.id=a.check_id WHERE a.application_id=$1 AND c.check_type='PAN' AND a.status='AWAITING_CALLBACK'",
          [apps[0]],
        )
      ).rows[0];
      if (attempt) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(attempt, 'No awaiting PAN attempt for callback burst');
    const event = {
      event_id: 'stress_' + randomUUID(),
      client_reference_id: attempt.id,
      provider_request_id: attempt.provider_request_id,
      status: 'VERIFIED',
      details: {},
      occurred_at: new Date().toISOString(),
    };
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headers = {
      'x-provider-timestamp': timestamp,
      'x-provider-signature': signature('pan', timestamp, JSON.stringify(event)),
    };
    await parallel(100, 40, async (i) => {
      assert.equal(
        (
          await request('callback_burst', '/api/v1/webhooks/providers/pan', {
            method: 'POST',
            body: event,
            headers,
            ip: 110 + (i % 30),
          })
        ).status,
        200,
      );
    });
    const inbox = (
      await pool.query('SELECT delivery_count,outcome FROM webhook_events WHERE event_id=$1', [
        event.event_id,
      ])
    ).rows;
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].delivery_count, 100);
    assert.equal(inbox[0].outcome, 'APPLIED');
    invariants.callback_burst_once = true;
    const deadline = Date.now() + 180000;
    let activated = 0;
    while (Date.now() < deadline) {
      activated = (
        await pool.query(
          "SELECT count(*)::int n FROM applications WHERE id=ANY($1) AND status='ACTIVATED'",
          [apps],
        )
      ).rows[0].n;
      if (activated === 30) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    assert.equal(activated, 30, 'All stress workflows must activate');
    assert.equal(
      (
        await pool.query('SELECT count(*)::int n FROM merchants WHERE application_id=ANY($1)', [
          apps,
        ])
      ).rows[0].n,
      30,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int n FROM audit_events WHERE application_id=ANY($1) AND event_type='MERCHANT_ID_CREATED'",
          [apps],
        )
      ).rows[0].n,
      30,
    );
    invariants.all_workflows_activate_once = true;
    // Abuse a separate source address so the test does not throttle normal users or callbacks.
    await parallel(400, 50, async () => {
      const r = await request('rate_limit', '/health', { ip: 220 });
      assert.ok([200, 429].includes(r.status));
    });
    assert.ok(metrics.rate_limit.some((r) => r.status === 429));
    assert.ok(metrics.rate_limit.some((r) => r.status === 200));
    assert.equal((await request('post_burst_health', '/health', { ip: 221 })).status, 200);
    invariants.rate_limit_and_service_survival = true;
  }
  // A dedicated Vite proxy preserves multipart bytes and never writes to the main database.
  const { chromium, expect } = await import('@playwright/test');
  const { createServer } = await import('vite');
  const web = await createServer({
    configFile: 'apps/web/vite.config.ts',
    server: {
      port: 5174,
      strictPort: true,
      proxy: { '/api': { target: 'http://127.0.0.1:3101', changeOrigin: true } },
    },
  });
  await web.listen();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(20000);
    page.setDefaultNavigationTimeout(20000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('http://localhost:5174/login');
    await page.getByRole('button', { name: 'Merchant Submit & track' }).click();
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('link', { name: 'New application', exact: true }).click();
    await page.getByRole('button', { name: 'Use PDF sample details' }).click();
    for (let i = 0; i < 3; i++)
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.locator('input[type=file]').first().setInputFiles('fixtures/documents/pan_card.pdf');
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await Promise.race([
      page.waitForURL(/\/merchant\/applications\/[a-f0-9-]+$/),
      page
        .getByRole('alert')
        .waitFor()
        .then(async () => {
          throw new Error('Draft save error: ' + (await page.getByRole('alert').innerText()));
        }),
    ]);
    const id = page.url().split('/').at(-1)!;
    const count = (
      await pool.query(
        'SELECT count(*)::int n FROM documents WHERE application_id=$1 AND is_active',
        [id],
      )
    ).rows[0].n;
    invariants.draft_preserves_selected_upload = count === 1;
    assert.equal(errors.length, 0);
    invariants.no_browser_errors = true;
    assert.equal(count, 1, 'Save draft must preserve selected files');
    const before = decrypt(
      (await pool.query('SELECT form_enc FROM applications WHERE id=$1', [id])).rows[0].form_enc,
    );
    await page.getByRole('button', { name: 'Update application', exact: true }).click();
    await page
      .getByLabel('Account Holder Name', { exact: true })
      .fill('Corrected Synthetic Holder');
    await page.getByLabel('Ifsc', { exact: true }).fill('TEST0000001');
    await page.getByLabel('Trade Name', { exact: true }).fill('');
    await page.getByLabel('Pincode', { exact: true }).fill('');
    const submitted = page.waitForResponse(
      (r) => r.url().endsWith(`/applications/${id}/submit`) && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Save & resubmit', exact: true }).click();
    assert.equal((await submitted).status(), 202);
    const after = decrypt(
      (await pool.query('SELECT form_enc FROM applications WHERE id=$1', [id])).rows[0].form_enc,
    );
    assert.equal(after.bank_account.account_holder_name, 'Corrected Synthetic Holder');
    assert.equal(after.bank_account.ifsc, 'TEST0000001');
    assert.equal(after.bank_account.account_number, before.bank_account.account_number);
    assert.equal(after.trade_name, '');
    assert.equal(after.pincode, undefined);
    invariants.optional_fields_can_be_cleared = true;
    invariants.holder_and_ifsc_update_without_account_reentry = true;
    const loginResult = await request('review_auth', '/api/v1/auth/login', {
      method: 'POST',
      body: { email: 'merchant@onboard.demo', password: 'DemoPass123!' },
    });
    const token = loginResult.data.token;
    const reviewForm = uniqueDemoForm('Consistency Textiles Private Limited');
    const created = await request('review_create', '/api/v1/applications', {
      method: 'POST',
      token,
      body: reviewForm,
    });
    assert.equal(created.status, 201);
    const reviewId = created.data.id;
    const evidence = demoDocuments(reviewForm);
    evidence.GST_CERTIFICATE.legal_name = 'Consistency Textiles Limited';
    for (const [doc_type, structured_payload] of Object.entries(evidence)) {
      assert.equal(
        (
          await request('review_upload', `/api/v1/applications/${reviewId}/documents`, {
            method: 'POST',
            token,
            body: { doc_type, structured_payload },
          })
        ).status,
        201,
      );
    }
    assert.equal(
      (
        await request('review_submit', `/api/v1/applications/${reviewId}/submit`, {
          method: 'POST',
          token,
        })
      ).status,
      202,
    );
    await expect
      .poll(
        async () =>
          (await request('review_poll', `/api/v1/applications/${reviewId}`, { token })).data.status,
        { timeout: 60000 },
      )
      .toBe('IN_REVIEW');
    await page.goto(`http://localhost:5174/merchant/applications/${reviewId}`);
    await expect(page.getByTestId('application-decision-summary')).toContainText(
      'Application: In Review',
    );
    await expect(page.getByText('3 of 4 checks cleared', { exact: false })).toBeVisible();
    await expect(page.getByTestId('document-GST_CERTIFICATE')).toContainText('In Review');
    await expect(page.getByTestId('check-GST').locator('.badge')).toHaveText('In Review');
    await expect(page.getByTestId('check-GST')).toContainText('Provider API (simulated): Passed');
    await page.getByRole('tab', { name: 'Checks', exact: true }).click();
    await expect(page.getByTestId('check-GST').locator('.badge')).toHaveText('In Review');
    await page.getByRole('tab', { name: 'Fields & documents', exact: true }).click();
    await expect(page.getByTestId('document-detail-GST_CERTIFICATE')).toContainText('In Review');
    const operatorPage = await browser.newPage();
    operatorPage.on('pageerror', (e) => errors.push(e.message));
    await operatorPage.goto('http://localhost:5174/login');
    await operatorPage.getByRole('button', { name: 'Operator Review & manage' }).click();
    await operatorPage.getByRole('button', { name: 'Sign in', exact: true }).click();
    await operatorPage.waitForURL('**/ops/applications');
    await operatorPage.goto(`http://localhost:5174/ops/applications/${reviewId}`);
    await expect(operatorPage.getByTestId('check-GST').locator('.badge')).toHaveText('In Review');
    await operatorPage.getByRole('tab', { name: /^Exceptions/ }).click();
    await operatorPage.getByRole('button', { name: 'Resolve exception' }).click();
    await operatorPage
      .getByLabel('Decision note')
      .fill('Supporting evidence checked and name difference accepted.');
    await operatorPage
      .getByRole('button', { name: 'Resolve exception', exact: true })
      .last()
      .click();
    await operatorPage.getByRole('tab', { name: 'Overview', exact: true }).click();
    await expect(operatorPage.getByTestId('document-GST_CERTIFICATE')).toContainText('Completed');
    await expect(operatorPage.getByTestId('check-GST').locator('.badge')).toHaveText('Passed');
    await expect(operatorPage.getByTestId('application-decision-summary')).toContainText(
      'An operator must still approve',
    );
    await page.getByRole('tab', { name: 'Overview', exact: true }).click();
    await expect(page.getByTestId('document-GST_CERTIFICATE')).toContainText('Completed');
    await expect(page.getByText('4 of 4 checks cleared', { exact: false })).toBeVisible();
    invariants.review_status_consistent_across_roles_and_tabs = true;
    const rejectionForm = uniqueDemoForm('Rejection Test Private Limited');
    const rejection = await request('rejection_create', '/api/v1/applications', {
      method: 'POST',
      token,
      body: rejectionForm,
    });
    assert.equal(rejection.status, 201);
    const rejectionId = rejection.data.id;
    const rejectionEvidence = demoDocuments(rejectionForm);
    rejectionEvidence.GST_CERTIFICATE.legal_name = 'Rejection Test Limited';
    for (const [doc_type, structured_payload] of Object.entries(rejectionEvidence))
      assert.equal(
        (
          await request('rejection_upload', `/api/v1/applications/${rejectionId}/documents`, {
            method: 'POST',
            token,
            body: { doc_type, structured_payload },
          })
        ).status,
        201,
      );
    await request('rejection_submit', `/api/v1/applications/${rejectionId}/submit`, {
      method: 'POST',
      token,
    });
    await expect
      .poll(
        async () =>
          (await request('rejection_poll', `/api/v1/applications/${rejectionId}`, { token })).data
            .status,
        { timeout: 60000 },
      )
      .toBe('IN_REVIEW');
    await operatorPage.goto(`http://localhost:5174/ops/applications/${rejectionId}`);
    await operatorPage.getByRole('button', { name: 'Reject', exact: true }).click();
    await expect(operatorPage.getByLabel('Rejection reason')).toHaveValue('INVALID_DOCUMENTS');
    await expect(operatorPage.getByLabel('Gst Certificate', { exact: true })).toBeChecked();
    await operatorPage
      .getByLabel('Decision note')
      .fill('GST legal name does not match the declared business.');
    await operatorPage.getByRole('button', { name: 'Reject', exact: true }).last().click();
    await expect(operatorPage.getByTestId('application-decision-summary')).toContainText(
      'Application: Rejected',
    );
    await expect(operatorPage.getByTestId('document-GST_CERTIFICATE').locator('.badge')).toHaveText(
      'Invalid',
    );
    await operatorPage.getByRole('tab', { name: /^Exceptions/ }).click();
    await expect(operatorPage.locator('.exception-full .badge')).toHaveText('Closed');
    await page.goto(`http://localhost:5174/merchant/applications/${rejectionId}`);
    await expect(page.getByTestId('check-GST').locator('.badge')).toHaveText('Invalid');
    await expect(page.getByTestId('application-decision-summary')).toContainText(
      'GST legal name does not match',
    );
    await page.getByRole('tab', { name: 'Fields & documents', exact: true }).click();
    await expect(page.getByTestId('document-detail-GST_CERTIFICATE')).toContainText('Invalid');
    invariants.rejection_closes_review_and_marks_selected_document_invalid = true;
    const countBeforeRetry = (await pool.query('SELECT count(*)::int n FROM applications')).rows[0]
      .n;
    await page.goto('http://localhost:5174/merchant/applications/new');
    await page.getByRole('button', { name: 'Use PDF sample details' }).click();
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Open existing application' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open existing application' })).toHaveAttribute(
      'href',
      `/merchant/applications/${id}`,
    );
    assert.equal(
      (await pool.query('SELECT count(*)::int n FROM applications')).rows[0].n,
      countBeforeRetry,
    );
    await page.getByRole('link', { name: 'Open existing application' }).click();
    await page.waitForURL(`**/merchant/applications/${id}`);
    invariants.repeated_wizard_opens_existing_application = true;
    assert.equal(errors.length, 0);
  } finally {
    await browser.close();
    await web.close();
  }
} catch (error) {
  failure = error instanceof Error ? error.message : 'Stress test failed';
  console.log('Stress invariant failed: ' + failure);
  process.exitCode = 1;
} finally {
  const summary = Object.fromEntries(
    Object.entries(metrics).map(([name, results]) => {
      const times = results.map((r) => r.ms).sort((a, b) => a - b);
      const statuses: Record<string, number> = {};
      for (const r of results) statuses[r.status] = (statuses[r.status] ?? 0) + 1;
      return [
        name,
        {
          requests: results.length,
          statuses,
          p50_ms: times[Math.floor(times.length * 0.5)],
          p95_ms: times[Math.min(times.length - 1, Math.floor(times.length * 0.95))],
          max_ms: times.at(-1),
        },
      ];
    }),
  );
  const report = {
    database,
    run_at: new Date().toISOString(),
    invariants,
    phases: summary,
    failure,
  };
  await mkdir('.local', { recursive: true });
  await writeFile('.local/stress-report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  await stopWorker();
  await stopDeliveries();
  await api.close();
  await mock.close();
  agent.destroy();
  await pool.end();
}
