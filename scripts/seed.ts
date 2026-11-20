import { ensureEnv } from './env.js';
import bcrypt from 'bcryptjs';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { demoForm, demoDocuments } from '../packages/shared/src/demo.js';
import { validPan, validGstin, type Form, type Scenario } from '../packages/shared/src/index.js';
ensureEnv();
export async function seedUsers() {
  const { pool } = await import('../apps/api/src/db.js');
  const hash = await bcrypt.hash('DemoPass123!', 10);
  for (const [email, role, name] of [
    ['merchant@onboard.demo', 'MERCHANT', 'Aarav Sharma'],
    ['operator@onboard.demo', 'OPERATOR', 'Priya Menon'],
    ['other@onboard.demo', 'MERCHANT', 'Riya Shah'],
  ])
    await pool.query(
      'INSERT INTO users(email,password_hash,role,display_name) VALUES($1,$2,$3,$4) ON CONFLICT(email) DO NOTHING',
      [email, hash, role, name],
    );
}
export async function seedApplications() {
  const { config } = await import('../apps/api/src/config.js');
  async function request(
    path: string,
    method = 'GET',
    body?: unknown,
    token?: string,
  ): Promise<any> {
    const res = await fetch(`${config.apiUrl}/api/v1${path}`, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    const result = await res.json();
    if (!res.ok)
      throw new Error(`Seed request ${path} failed: ${result.error?.code ?? res.status}`);
    return result;
  }
  const merchant = await request('/auth/login', 'POST', {
      email: 'merchant@onboard.demo',
      password: 'DemoPass123!',
    }),
    operator = await request('/auth/login', 'POST', {
      email: 'operator@onboard.demo',
      password: 'DemoPass123!',
    });
  const prior = await request('/applications', 'GET', undefined, merchant.token);
  if (prior.total) {
    console.log('Demo applications already exist; use npm run demo:reset for a fresh demo.');
    return;
  }
  const seeded: Array<{ id: string; name: string; expected: string }> = [];
  async function add(
    n: number,
    name: string,
    expected: string,
    scenario?: Partial<Scenario>,
    blur = false,
    override?: Form,
  ) {
    const form = override ?? demoForm(n, name);
    if (!validPan(form.pan!) || !validGstin(form.gstin!))
      throw new Error('Invalid generated fixture identifier');
    const a = await request('/applications', 'POST', form, merchant.token);
    if (scenario)
      await request(
        '/simulator/scenarios',
        'PUT',
        {
          target: 'gst',
          behavior: 'SUCCESS',
          delay_ms: 2000,
          times: 1,
          ...scenario,
          application_id: a.id,
        },
        operator.token,
      );
    for (const [type, payload] of Object.entries(demoDocuments(form))) {
      if (blur && type === 'PAN_CARD') {
        const body = new FormData();
        body.append('doc_type', type);
        body.append(
          'file',
          new Blob([await readFile('fixtures/documents/blurred_pan.pdf')], {
            type: 'application/pdf',
          }),
          'blurred_pan.pdf',
        );
        const res = await fetch(`${config.apiUrl}/api/v1/applications/${a.id}/documents`, {
          method: 'POST',
          headers: { authorization: `Bearer ${merchant.token}` },
          body,
        });
        if (!res.ok) throw new Error('Seed document upload failed');
      } else
        await request(
          `/applications/${a.id}/documents`,
          'POST',
          { doc_type: type, structured_payload: payload },
          merchant.token,
        );
    }
    await request(`/applications/${a.id}/submit`, 'POST', undefined, merchant.token);
    seeded.push({ id: a.id, name, expected });
    return a.id;
  }
  await add(2, 'Malabar Spice Traders LLP', 'IN_REVIEW', {
    target: 'gst',
    behavior: 'FAIL',
    reason_code: 'GSTIN_CANCELLED',
  });
  await add(3, 'Deccan Home Foods', 'NEEDS_INFO', undefined, true);
  const nilgiri = await add(4, 'Nilgiri Tea Estates Private Limited', 'ACTIVATED', {
    target: 'bank',
    behavior: 'DUPLICATE_CALLBACK',
    repeats: 3,
  });
  await add(5, 'Konkan Marine Supplies', 'ACTIVATED', {
    target: 'pan',
    behavior: 'LATE_CALLBACK',
    delay_ms: 18000,
  });
  await add(6, 'Sahyadri Electronics Private Limited', 'PROVISIONING_FAILED', {
    target: 'merchant-core',
    behavior: 'HTTP_503',
    times: 4,
  });
  // Let the original finish before submitting its deliberate duplicate.
  const originalDeadline = Date.now() + 30000;
  while (
    (await request(`/applications/${nilgiri}`, 'GET', undefined, operator.token)).status !==
    'ACTIVATED'
  ) {
    if (Date.now() > originalDeadline)
      throw new Error('Original duplicate-demo application failed to activate');
    await new Promise((r) => setTimeout(r, 1000));
  }
  const duplicate = demoForm(4, 'Nilgiri Tea Estates — Second Application');
  await add(7, duplicate.legal_name, 'IN_REVIEW', undefined, false, duplicate);
  await add(8, 'Aravalli Stone Works', 'IN_REVIEW', {
    target: 'risk',
    behavior: 'RISK_BAND',
    band: 'MEDIUM',
  });
  for (const [i, name] of [
    'Coromandel Books',
    'Narmada Handcrafts',
    'Himalaya Organics',
    'Mysore Coffee Collective',
    'Godavari Homewares',
    'Coastal Cycle Studio',
    'Lotus Paper Company',
    'Sundarban Crafts',
    'Vindhya Ceramics',
    'Cauvery Farm Supply',
  ].entries())
    await add(20 + i, name, 'ACTIVATED');
  const deadline = Date.now() + 120000;
  const pending = new Map(seeded.map((a) => [a.id, a]));
  while (pending.size && Date.now() < deadline) {
    const listing = await request('/applications?page_size=100', 'GET', undefined, operator.token);
    for (const [id, a] of pending) {
      const current = listing.items.find((item: any) => item.id === id);
      if (current?.status === a.expected) pending.delete(id);
    }
    if (pending.size) await new Promise((r) => setTimeout(r, 1000));
  }
  if (pending.size)
    throw new Error(
      `Demo seed did not reach expected states: ${[...pending.values()].map((a) => a.name).join(', ')}`,
    );
  console.log(
    `Seeded and verified ${seeded.length} synthetic applications, including all exception demonstrations.`,
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await seedUsers();
  await seedApplications();
  const { pool } = await import('../apps/api/src/db.js');
  await pool.end();
}
