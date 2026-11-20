import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { uniqueDemoForm, demoDocuments } from '../../packages/shared/src/demo.js';
import { gstCheck } from '../../packages/shared/src/index.js';
async function login(page: Page, role: 'merchant' | 'operator') {
  await page.goto('/login');
  await page
    .getByRole('button', {
      name: role === 'merchant' ? 'Merchant Submit & track' : 'Operator Review & manage',
    })
    .click();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(
    new RegExp(`/${role === 'merchant' ? 'merchant' : 'ops'}/applications`),
  );
}
test('T-E1 merchant wizard → real signed HTTP callbacks → one activated merchant', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await login(page, 'merchant');
  await page.getByRole('link', { name: 'New application', exact: true }).click();
  await page.getByRole('button', { name: 'Fill synthetic sample' }).click();
  for (let i = 0; i < 4; i++)
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Submit application', exact: true }).click();
  await expect(page.getByTestId('merchant-id')).toBeVisible({ timeout: 60000 });
  await expect(page.getByTestId('merchant-id')).toContainText('MID');
  await page.getByRole('tab', { name: 'Checks', exact: true }).click();
  await expect(page.getByText('Applied', { exact: true })).toHaveCount(4);
  await page.screenshot({ path: 'test-results/merchant-activated.png', fullPage: true });
  expect(errors).toEqual([]);
});
test('T-E2 operator requests GST correction, merchant replaces evidence, selective checks activate', async ({
  page,
  request,
}) => {
  const api = 'http://127.0.0.1:3001/api/v1';
  async function token(role: string) {
    const r = await request.post(`${api}/auth/login`, {
      data: { email: `${role}@onboard.demo`, password: 'DemoPass123!' },
    });
    expect(r.ok()).toBeTruthy();
    return (await r.json()).token;
  }
  const merchant = await token('merchant'),
    operator = await token('operator');
  const mh = { authorization: `Bearer ${merchant}` },
    oh = { authorization: `Bearer ${operator}` };
  const n = 1000 + (Date.now() % 8000),
    f = uniqueDemoForm(`E2E Review Store ${n}`);
  const created = await request.post(`${api}/applications`, { headers: mh, data: f });
  expect(created.status()).toBe(201);
  const { id } = await created.json();
  expect(
    (
      await request.put(`${api}/simulator/scenarios`, {
        headers: oh,
        data: {
          target: 'gst',
          behavior: 'FAIL',
          reason_code: 'GSTIN_CANCELLED',
          application_id: id,
          delay_ms: 300,
          times: 1,
        },
      })
    ).ok(),
  ).toBeTruthy();
  for (const [doc_type, structured_payload] of Object.entries(demoDocuments(f)))
    expect(
      (
        await request.post(`${api}/applications/${id}/documents`, {
          headers: mh,
          data: { doc_type, structured_payload },
        })
      ).status(),
    ).toBe(201);
  expect((await request.post(`${api}/applications/${id}/submit`, { headers: mh })).status()).toBe(
    202,
  );
  await expect
    .poll(
      async () =>
        (await (await request.get(`${api}/applications/${id}`, { headers: oh })).json()).status,
      { timeout: 30000 },
    )
    .toBe('IN_REVIEW');
  // This scenario specifically proves preservation of checks that have already passed.
  // A request for information correctly supersedes any still-open attempts.
  await expect
    .poll(
      async () => {
        const current = await (
          await request.get(`${api}/applications/${id}`, { headers: oh })
        ).json();
        return current.checks.filter(
          (c: any) => ['PAN', 'BANK'].includes(c.check_type) && c.status === 'PASSED',
        ).length;
      },
      { timeout: 30000 },
    )
    .toBe(2);
  await login(page, 'operator');
  await page.goto(`/ops/applications/${id}`);
  await expect(page.getByRole('button', { name: 'Approve application', exact: true })).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: 'Request information', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByLabel('Request to the merchant')
    .fill('Please supply your corrected GST registration and certificate.');
  await dialog
    .getByLabel('Decision note')
    .fill('GST provider reports a cancelled registration. Please correct the registration.');
  await dialog.getByRole('button', { name: 'Request Info', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await login(page, 'merchant');
  await page.goto(`/merchant/applications/${id}`);
  await page.getByRole('button', { name: 'Update details & documents' }).click();
  const editor = page.getByRole('dialog');
  const prefix = `27${f.pan}1Z`,
    gstin = prefix + gstCheck(prefix);
  await editor.getByLabel('Gstin', { exact: true }).fill(gstin);
  await editor.getByLabel('Replace Gst Certificate', { exact: true }).check();
  await editor.getByLabel('Gst Certificate input mode').selectOption('structured');
  await editor.getByLabel('Gstin', { exact: true }).nth(1).fill(gstin);
  await editor.getByLabel('Legal Name', { exact: true }).nth(1).fill(f.legal_name);
  await editor.getByLabel('Trade Name', { exact: true }).nth(1).fill(f.trade_name!);
  await editor.getByRole('button', { name: 'Save & resubmit' }).click();
  await expect(page.getByTestId('merchant-id')).toBeVisible({ timeout: 60000 });
  const final = await (await request.get(`${api}/applications/${id}`, { headers: oh })).json();
  expect(final.checks.find((c: any) => c.check_type === 'PAN').attempts).toHaveLength(1);
  expect(final.checks.find((c: any) => c.check_type === 'BANK').attempts).toHaveLength(1);
  expect(final.checks.find((c: any) => c.check_type === 'GST').attempts).toHaveLength(2);
});
test('Operator screens and mobile layout render without browser errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await login(page, 'operator');
  await expect(page.getByRole('heading', { name: 'Merchant applications' })).toBeVisible();
  await expect(page.locator('.stat strong').first()).toHaveText(/^\d+$/);
  await page.screenshot({ path: 'test-results/operator-desktop.png', fullPage: true });
  for (const [url, title] of [
    ['review', 'Review queue'],
    ['metrics', 'Every journey, in perspective.'],
    ['dead-letters', 'Dead letters'],
    ['simulator', 'Provider simulator'],
  ]) {
    const endpoint =
      url === 'review'
        ? 'review-queue'
        : url === 'metrics'
          ? 'metrics/summary'
          : url === 'dead-letters'
            ? 'dead-letters'
            : 'simulator/scenarios';
    const response = page.waitForResponse((r) => r.url().includes(`/api/v1/${endpoint}`));
    await page.goto(`/ops/${url}`);
    expect((await response).ok()).toBeTruthy();
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/ops/applications');
  await expect(page.getByRole('heading', { name: 'Merchant applications' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: 'test-results/operator-mobile.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('Human review approval survives provisioning outage and recovers through the UI', async ({
  page,
  request,
}) => {
  const base = 'http://127.0.0.1:3001/api/v1';
  const loginResult = await request.post(base + '/auth/login', {
    data: { email: 'merchant@onboard.demo', password: 'DemoPass123!' },
  });
  const mh = { authorization: `Bearer ${(await loginResult.json()).token}` };
  const opResult = await request.post(base + '/auth/login', {
    data: { email: 'operator@onboard.demo', password: 'DemoPass123!' },
  });
  const oh = { authorization: `Bearer ${(await opResult.json()).token}` };
  const n = 1000 + (Date.now() % 8000),
    form = uniqueDemoForm(`Human Review ${n}`);
  const creation = await request.post(base + '/applications', { headers: mh, data: form });
  expect(creation.status()).toBe(201);
  const { id } = await creation.json();
  for (const rule of [
    { target: 'risk', behavior: 'RISK_BAND', band: 'MEDIUM', times: 1 },
    { target: 'merchant-core', behavior: 'HTTP_503', times: 4 },
  ])
    expect(
      (
        await request.put(base + '/simulator/scenarios', {
          headers: oh,
          data: { ...rule, application_id: id, delay_ms: 300 },
        })
      ).ok(),
    ).toBeTruthy();
  for (const [doc_type, structured_payload] of Object.entries(demoDocuments(form)))
    await request.post(`${base}/applications/${id}/documents`, {
      headers: mh,
      data: { doc_type, structured_payload },
    });
  await request.post(`${base}/applications/${id}/submit`, { headers: mh });
  await expect
    .poll(
      async () =>
        (await (await request.get(`${base}/applications/${id}`, { headers: oh })).json()).status,
      { timeout: 30000 },
    )
    .toBe('IN_REVIEW');
  await login(page, 'operator');
  await page.goto(`/ops/applications/${id}`);
  await page.getByRole('tab', { name: /Exceptions/ }).click();
  await page.getByRole('button', { name: 'Resolve exception', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByLabel('Decision note')
    .fill('Risk evidence reviewed and accepted by the operator.');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Resolve exception', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Approve application', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByLabel('Decision note')
    .fill('All required checks and evidence have been confirmed.');
  await page.getByRole('dialog').getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByText('Approved. Activation needs another attempt.')).toBeVisible({
    timeout: 45000,
  });
  await page.getByRole('button', { name: 'Retry provisioning', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByLabel('Decision note')
    .fill('Merchant core has recovered from its simulated outage.');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Retry Provisioning', exact: true })
    .click();
  await expect(page.getByTestId('merchant-id')).toBeVisible({ timeout: 30000 });
  const result = await (await request.get(`${base}/applications/${id}`, { headers: oh })).json();
  expect(result.approved_by).toBeTruthy();
});
test('Merchant bank change invalidates only BANK and RISK in the live UI', async ({
  page,
  request,
}) => {
  const base = 'http://127.0.0.1:3001/api/v1';
  const m = await request.post(base + '/auth/login', {
    data: { email: 'merchant@onboard.demo', password: 'DemoPass123!' },
  });
  const mh = { authorization: `Bearer ${(await m.json()).token}` };
  const o = await request.post(base + '/auth/login', {
    data: { email: 'operator@onboard.demo', password: 'DemoPass123!' },
  });
  const oh = { authorization: `Bearer ${(await o.json()).token}` };
  const n = 1000 + (Date.now() % 8000),
    form = uniqueDemoForm(`Bank Change ${n}`);
  const created = await request.post(base + '/applications', { headers: mh, data: form });
  expect(created.status()).toBe(201);
  const { id } = await created.json();
  await request.put(base + '/simulator/scenarios', {
    headers: oh,
    data: {
      target: 'risk',
      behavior: 'RISK_BAND',
      band: 'MEDIUM',
      application_id: id,
      delay_ms: 300,
      times: 1,
    },
  });
  for (const [doc_type, structured_payload] of Object.entries(demoDocuments(form)))
    await request.post(`${base}/applications/${id}/documents`, {
      headers: mh,
      data: { doc_type, structured_payload },
    });
  await request.post(`${base}/applications/${id}/submit`, { headers: mh });
  await expect
    .poll(
      async () =>
        (await (await request.get(`${base}/applications/${id}`, { headers: oh })).json()).status,
      { timeout: 30000 },
    )
    .toBe('IN_REVIEW');
  await login(page, 'merchant');
  await page.goto(`/merchant/applications/${id}`);
  await page.getByRole('button', { name: 'Change bank details', exact: true }).click();
  await page.getByRole('dialog').getByLabel('New account number').fill(`98765432${n}`);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Update & verify', exact: true })
    .click();
  await expect(page.getByTestId('merchant-id')).toBeVisible({ timeout: 30000 });
  const result = await (await request.get(`${base}/applications/${id}`, { headers: oh })).json();
  for (const t of ['PAN', 'GST'])
    expect(result.checks.find((c: any) => c.check_type === t).attempts).toHaveLength(1);
  for (const t of ['BANK', 'RISK'])
    expect(result.checks.find((c: any) => c.check_type === t).attempts).toHaveLength(2);
  await expect(page.getByRole('button', { name: 'Change bank details', exact: true })).toHaveCount(
    0,
  );
});
