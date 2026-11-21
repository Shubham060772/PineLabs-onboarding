import { beforeAll, beforeEach, afterAll, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extractor } from '../apps/api/src/extraction.js';
import bcrypt from 'bcryptjs';
import { pool, transaction, lockApp, enqueue } from '../apps/api/src/db.js';
import { intake, receiveCallback, timeoutAttempt, guard } from '../apps/api/src/workflow.js';
import {
  createApplication,
  uploadDocument,
  submit,
  detail,
  changeBank,
  operatorAction,
  editApplication,
} from '../apps/api/src/applications.js';
import { claimJob, runJob, backoff } from '../apps/api/src/jobs.js';
import { providers, merchantCore, ProviderHttpError } from '../apps/api/src/providers.js';
import { buildServer } from '../apps/api/src/server.js';
import { encrypt, signature } from '../apps/api/src/crypto.js';
import { demoForm, demoDocuments } from '../packages/shared/src/demo.js';
import {
  type Actor,
  type Callback,
  type CheckType,
  type User,
  type Form,
  DOC_TYPES,
  system,
} from '../packages/shared/src/index.js';
let merchant: User,
  other: User,
  operator: User,
  api: Awaited<ReturnType<typeof buildServer>>,
  mtoken: string,
  otoken: string;
const mActor = (): Actor => ({ type: 'MERCHANT', id: merchant.id });
const oActor = (): Actor => ({ type: 'OPERATOR', id: operator.id });
beforeAll(async () => {
  api = await buildServer();
});
beforeEach(async () => {
  vi.restoreAllMocks();
  const db = (await pool.query('SELECT current_database() AS name')).rows[0].name;
  if (db !== 'onboard_test') throw new Error('Refusing to reset a non-test database');
  await pool.query(
    'TRUNCATE users,applications,documents,extracted_fields,validation_findings,info_requests,verification_checks,check_attempts,webhook_events,application_exceptions,duplicate_matches,merchants,jobs,audit_events,mock_requests,mock_scenarios,mock_merchants RESTART IDENTITY CASCADE',
  );
  await pool.query(
    'UPDATE check_policies SET enabled=true,required=true,max_attempts=2,timeout_seconds=15',
  );
  const password = await bcrypt.hash('DemoPass123!', 4);
  const users = (
    await pool.query(
      "INSERT INTO users(email,password_hash,role,display_name) VALUES('merchant@onboard.demo',$1,'MERCHANT','Merchant'),('other@onboard.demo',$1,'MERCHANT','Other'),('operator@onboard.demo',$1,'OPERATOR','Operator') RETURNING id,email,role,display_name",
      [password],
    )
  ).rows;
  [merchant, other, operator] = users;
  mtoken = api.jwt.sign(merchant);
  otoken = api.jwt.sign(operator);
  vi.spyOn(providers, 'dispatch').mockImplementation(async (_type, id) => ({
    provider_request_id: `request_${id}`,
  }));
  vi.spyOn(merchantCore, 'create').mockImplementation(async (id) => ({
    merchant_id: `MID${id.replaceAll('-', '').toUpperCase()}`,
  }));
});
afterAll(async () => {
  await api.close();
  await pool.end();
});
it('lets registered merchants sign in and isolates their applications while operators see both', async () => {
  const ids: string[] = [];
  const tokens: string[] = [];
  for (const name of ['First', 'Second']) {
    const payload = {
      display_name: name,
      email: name + '@example.test',
      password: 'merchant-test-password',
    };
    const register = await api.inject({ method: 'POST', url: '/api/v1/auth/register', payload });
    expect(register.statusCode).toBe(201);
    expect(register.json().user.role).toBe('MERCHANT');
    const login = await api.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: payload.email, password: payload.password },
    });
    expect(login.statusCode).toBe(200);
    tokens.push(login.json().token);
    const draft = await api.inject({
      method: 'POST',
      url: '/api/v1/applications',
      headers: { authorization: 'Bearer ' + register.json().token },
      payload: demoForm(),
    });
    expect(draft.statusCode).toBe(201);
    ids.push(draft.json().id);
    const owner = { display_name: name, email: payload.email.toLowerCase() };
    const operatorHeaders = { authorization: 'Bearer ' + otoken };
    const list = await api.inject({ url: '/api/v1/applications', headers: operatorHeaders });
    expect(
      list.json().items.find((item: { id: string }) => item.id === draft.json().id).submitted_by,
    ).toEqual(owner);
    const url = '/api/v1/applications/' + draft.json().id;
    expect((await api.inject({ url, headers: operatorHeaders })).json().submitted_by).toEqual({
      ...owner,
      id: register.json().user.id,
    });
    expect(
      (
        await api.inject({ url, headers: { authorization: 'Bearer ' + login.json().token } })
      ).json(),
    ).not.toHaveProperty('submitted_by');
    const duplicate = await api.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { ...payload, email: payload.email.toUpperCase() },
    });
    expect(duplicate.statusCode).toBe(409);
  }
  async function visible(token: string) {
    const response = await api.inject({
      url: '/api/v1/applications',
      headers: { authorization: 'Bearer ' + token },
    });
    return response.json().items.map((item: { id: string }) => item.id);
  }
  expect(await visible(tokens[0])).toEqual([ids[0]]);
  expect(await visible(tokens[1])).toEqual([ids[1]]);
  expect(await visible(otoken)).toEqual(expect.arrayContaining(ids));
  const elevated = await api.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      display_name: 'Third',
      email: 'third@example.test',
      password: 'another-password',
      role: 'OPERATOR',
    },
  });
  expect(elevated.statusCode).toBe(400);
});
it('rejects non-JSON webhook bodies without a server error', async () => {
  const response = await api.inject({
    method: 'POST',
    url: '/api/v1/webhooks/providers/pan',
    headers: {
      'content-type': 'application/octet-stream',
      'x-provider-timestamp': String(Math.floor(Date.now() / 1000)),
      'x-provider-signature': 'a'.repeat(64),
    },
    payload: Buffer.from('invalid'),
  });
  expect(response.statusCode).toBe(415);
});
it('rejects a callback referring to a different acknowledged provider request', async () => {
  const id = await create();
  const attempt = (await attempts(id, 'PAN'))[0];
  await pool.query(
    "UPDATE check_attempts SET status='AWAITING_CALLBACK',provider_request_id=$2,deadline_at=now()+interval '1 minute' WHERE id=$1",
    [attempt.id, 'expected-provider-request'],
  );
  await expect(
    callback(attempt, { provider_request_id: 'wrong-provider-request' }),
  ).rejects.toMatchObject({ code: 'PROVIDER_REQUEST_MISMATCH' });
  expect(
    (await pool.query('SELECT status FROM check_attempts WHERE id=$1', [attempt.id])).rows[0]
      .status,
  ).toBe('AWAITING_CALLBACK');
  expect(
    (await callback(attempt, { provider_request_id: 'expected-provider-request' })).outcome,
  ).toBe('APPLIED');
});
it.each(['FILE', 'STRUCTURED'] as const)(
  'repeated %s uploads keep the same document record',
  async (source) => {
    const a = await createApplication(demoForm(), merchant, mActor());
    const input =
      source === 'FILE'
        ? { doc_type: 'PAN_CARD' as const, file: await readFile('fixtures/documents/pan_card.pdf') }
        : { doc_type: 'PAN_CARD' as const, structured_payload: demoDocuments(demoForm()).PAN_CARD };
    const uploaded = await Promise.all(
      Array.from({ length: 5 }, () => uploadDocument(a.id, input, merchant, mActor())),
    );
    expect(new Set(uploaded.map((d) => d.id)).size).toBe(1);
    expect(
      (await pool.query('SELECT count(*)::int n FROM documents WHERE application_id=$1', [a.id]))
        .rows[0].n,
    ).toBe(1);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM audit_events WHERE application_id=$1 AND event_type='DOCUMENT_UPLOADED'",
          [a.id],
        )
      ).rows[0].n,
    ).toBe(1);
  },
);
it('saves holder and IFSC corrections without requiring the masked account number again', async () => {
  const form = demoForm();
  const app = await createApplication(form, merchant, mActor());
  for (const bankPatch of [
    { account_holder_name: 'Corrected Account Holder' },
    { ifsc: 'TEST0000001' },
  ]) {
    const response = await api.inject({
      method: 'PATCH',
      url: `/api/v1/applications/${app.id}`,
      headers: { authorization: `Bearer ${mtoken}` },
      payload: { bank_account: bankPatch },
    });
    expect(response.statusCode).toBe(200);
  }
  const updated = await detail(app.id, merchant);
  expect(updated.form.bank_account_holder_name).toBe('Corrected Account Holder');
  expect(updated.form.bank_ifsc).toBe('TEST0000001');
  expect(updated.form.bank_account_masked).toBe(
    '*'.repeat(form.bank_account!.account_number.length - 4) +
      form.bank_account!.account_number.slice(-4),
  );
  const invalid = await api.inject({
    method: 'PATCH',
    url: `/api/v1/applications/${app.id}`,
    headers: { authorization: `Bearer ${mtoken}` },
    payload: { bank_account: { account_holder_name: '' } },
  });
  expect(invalid.statusCode).toBe(400);
  await submit(app.id, merchant, mActor());
  await intake(app.id);
  expect((await detail(app.id, merchant)).form.bank_account_holder_name).toBe(
    'Corrected Account Holder',
  );
});
it('clears optional form fields and rejects empty required names without losing existing data', async () => {
  const app = await createApplication(demoForm(), merchant, mActor());
  const headers = { authorization: `Bearer ${mtoken}` };
  expect(
    (
      await api.inject({
        method: 'PATCH',
        url: `/api/v1/applications/${app.id}`,
        headers,
        payload: { trade_name: '', pincode: null },
      })
    ).statusCode,
  ).toBe(200);
  const d = await detail(app.id, merchant);
  expect(d.form.trade_name).toBe('');
  expect(d.form.pincode).toBeUndefined();
  expect(
    (
      await api.inject({
        method: 'PATCH',
        url: `/api/v1/applications/${app.id}`,
        headers,
        payload: { legal_name: '' },
      })
    ).statusCode,
  ).toBe(400);
  expect((await detail(app.id, merchant)).form.legal_name).toBe(demoForm().legal_name);
});
async function create(f = demoForm(), modify?: (type: string, payload: any) => void) {
  const a = await createApplication(f, merchant, mActor());
  for (const [type, p] of Object.entries(demoDocuments(f))) {
    modify?.(type, p);
    await uploadDocument(
      a.id,
      { doc_type: type as any, structured_payload: p },
      merchant,
      mActor(),
    );
  }
  await submit(a.id, merchant, mActor());
  await intake(a.id);
  return a.id;
}
async function attempts(id: string, type?: CheckType) {
  return (
    await pool.query(
      `SELECT a.*,c.check_type FROM check_attempts a JOIN verification_checks c ON c.id=a.check_id WHERE a.application_id=$1 ${type ? 'AND c.check_type=$2' : ''} ORDER BY attempt_no,check_type`,
      type ? [id, type] : [id],
    )
  ).rows;
}
function payload(a: any, options: Partial<Callback> = {}): Callback {
  return {
    event_id: `evt_${randomUUID()}`,
    client_reference_id: a.id,
    provider_request_id: `request_${a.id}`,
    status: a.check_type === 'RISK' ? 'ASSESSED' : 'VERIFIED',
    details: a.check_type === 'RISK' ? { score: 10, band: 'LOW' } : {},
    occurred_at: new Date().toISOString(),
    ...options,
  };
}
async function callback(a: any, options: Partial<Callback> = {}) {
  return receiveCallback(a.check_type.toLowerCase(), payload(a, options));
}
async function finish(id: string, risk: Partial<Callback> = {}) {
  for (const a of await attempts(id)) {
    if (a.check_type !== 'RISK' && ['QUEUED', 'AWAITING_CALLBACK'].includes(a.status))
      await callback(a);
  }
  const riskAttempts = await attempts(id, 'RISK');
  for (const a of riskAttempts)
    if (['QUEUED', 'AWAITING_CALLBACK'].includes(a.status)) await callback(a, risk);
}
async function drain() {
  for (let i = 0; i < 30; i++) {
    const job = await claimJob();
    if (!job) return;
    await runJob(job);
  }
  throw new Error('Job drain exceeded bound');
}
async function state(id: string) {
  return (await pool.query('SELECT * FROM applications WHERE id=$1', [id])).rows[0];
}
async function expire(a: any) {
  await pool.query(
    "UPDATE check_attempts SET status='AWAITING_CALLBACK',deadline_at=now()-interval '1 second' WHERE id=$1",
    [a.id],
  );
  await transaction(async (tx) => {
    const app = await lockApp(tx, a.application_id);
    const updated = (await tx.query('SELECT * FROM check_attempts WHERE id=$1', [a.id])).rows[0];
    await timeoutAttempt(tx, app, updated);
  });
}
async function medium() {
  const id = await create();
  await finish(id, { details: { band: 'MEDIUM', score: 45 } });
  return id;
}

it('T-I1 happy path activates exactly one merchant', async () => {
  const id = await create();
  await finish(id);
  await drain();
  expect((await state(id)).status).toBe('ACTIVATED');
  expect((await state(id)).approved_by).toBeNull();
  expect((await pool.query('SELECT * FROM merchants')).rowCount).toBe(1);
});

it('rejects unsupported content types with 415 rather than a server error', async () => {
  const response = await api.inject({
    method: 'POST',
    url: '/api/v1/applications',
    headers: { authorization: `Bearer ${mtoken}`, 'content-type': 'application/xml' },
    payload: '<application/>',
  });
  expect(response.statusCode).toBe(415);
});

it('revokes API access when the account behind a still-valid JWT is removed', async () => {
  const token = api.jwt.sign(other);
  await pool.query('DELETE FROM users WHERE id=$1', [other.id]);
  const response = await api.inject({
    url: '/api/v1/applications',
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.statusCode).toBe(401);
});

it('uses current account permissions instead of stale JWT role claims', async () => {
  const token = api.jwt.sign(operator);
  await pool.query("UPDATE users SET role='MERCHANT' WHERE id=$1", [operator.id]);
  const response = await api.inject({
    url: '/api/v1/metrics/summary',
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.statusCode).toBe(403);
});

it('low-confidence matching document names require review and cannot auto-approve', async () => {
  const original = extractor.extract.bind(extractor);
  vi.spyOn(extractor, 'extract').mockImplementation(async (doc) => {
    const result = await original(doc);
    if (doc.doc_type === 'PAN_CARD') result.fields.name.confidence = 0.1;
    return result;
  });
  const id = await create();
  await finish(id);
  const result = await detail(id, operator);
  expect(result.status).toBe('IN_REVIEW');
  expect(result.exceptions).toContainEqual(
    expect.objectContaining({
      type: 'LOW_CONFIDENCE_EXTRACTION',
      status: 'OPEN',
      details: expect.objectContaining({ field_name: 'name' }),
    }),
  );
  expect(result.allowed_actions).not.toContain('APPROVE');
});

it('overlapping extraction workers validate the committed evidence rather than a discarded model response', async () => {
  const a = await createApplication(demoForm(), merchant, mActor());
  for (const [type, payload] of Object.entries(demoDocuments(demoForm())))
    await uploadDocument(
      a.id,
      { doc_type: type as any, structured_payload: payload },
      merchant,
      mActor(),
    );
  await submit(a.id, merchant, mActor());
  const original = extractor.extract.bind(extractor);
  let banks = 0,
    gsts = 0;
  let releaseBanks!: () => void, signalFirstGst!: () => void, releaseSlowGst!: () => void;
  const bothBanks = new Promise<void>((r) => {
    releaseBanks = r;
  });
  const firstGst = new Promise<void>((r) => {
    signalFirstGst = r;
  });
  const slowGst = new Promise<void>((r) => {
    releaseSlowGst = r;
  });
  vi.spyOn(extractor, 'extract').mockImplementation(async (doc) => {
    const normal = await original(doc);
    if (doc.doc_type === 'BANK_PROOF') {
      if (++banks === 1) await bothBanks;
      else {
        releaseBanks();
        await firstGst;
        return { ...normal, detected_document_type: 'OTHER' };
      }
    }
    if (doc.doc_type === 'GST_CERTIFICATE' && ++gsts === 1) {
      signalFirstGst();
      await slowGst;
    }
    return normal;
  });
  const runs = [intake(a.id), intake(a.id)];
  await Promise.race(runs);
  releaseSlowGst();
  await Promise.all(runs);
  const result = await detail(a.id, merchant);
  expect(result.documents.every((d) => d.detected_doc_type === d.doc_type)).toBe(true);
  expect(result.findings.filter((f) => !f.passed && f.severity === 'BLOCKING')).toEqual([]);
  expect(result.status).toBe('VERIFYING');
});

it('the three sample PDFs upload, extract matching fields and activate', async () => {
  const a = await createApplication(demoForm(), merchant, mActor());
  for (const doc_type of DOC_TYPES)
    await uploadDocument(
      a.id,
      { doc_type, file: await readFile(`fixtures/documents/${doc_type.toLowerCase()}.pdf`) },
      merchant,
      mActor(),
    );
  await submit(a.id, merchant, mActor());
  await intake(a.id);
  const extracted = await detail(a.id, merchant);
  expect(extracted.documents).toHaveLength(3);
  expect(
    extracted.documents.every(
      (d) =>
        d.extraction_status === 'COMPLETED' &&
        d.document_status === 'COMPLETED' &&
        d.detected_doc_type === d.doc_type,
    ),
  ).toBe(true);
  expect(extracted.findings.filter((f) => !f.passed && f.severity === 'BLOCKING')).toEqual([]);
  await finish(a.id);
  await drain();
  expect((await state(a.id)).status).toBe('ACTIVATED');
});

it.each(
  DOC_TYPES.flatMap((type) =>
    ['unrelated', 'unknown_document'].map((file) => [type, file] as const),
  ),
)('blocks %s when the uploaded PDF is %s without dispatching checks', async (doc_type, file) => {
  const a = await createApplication(demoForm(), merchant, mActor());
  for (const type of DOC_TYPES)
    await uploadDocument(
      a.id,
      type === doc_type
        ? { doc_type: type, file: await readFile(`fixtures/documents/${file}.pdf`) }
        : { doc_type: type, structured_payload: demoDocuments(demoForm())[type] },
      merchant,
      mActor(),
    );
  await submit(a.id, merchant, mActor());
  await intake(a.id);
  const result = await detail(a.id, merchant);
  expect(result.status).toBe('NEEDS_INFO');
  expect(result.documents.find((d) => d.doc_type === doc_type)).toMatchObject({
    document_status: 'NEEDS_INFO',
    detected_doc_type: file === 'unrelated' ? 'OTHER' : 'UNKNOWN',
  });
  expect(result.findings).toContainEqual(
    expect.objectContaining({
      rule_code: 'V-DOC-TYPE',
      doc_type,
      passed: false,
      severity: 'BLOCKING',
    }),
  );
  expect(result.info_requests[0].items).toContainEqual(
    expect.objectContaining({ target: doc_type, target_type: 'DOCUMENT', code: 'V-DOC-TYPE' }),
  );
  expect(await attempts(a.id)).toHaveLength(0);
  expect(providers.dispatch).not.toHaveBeenCalled();
  expect(result.allowed_actions).not.toContain('APPROVE');
});

it('replacement of a wrong-type PDF clears the blocker and preserves other extractions', async () => {
  const a = await createApplication(demoForm(), merchant, mActor());
  for (const doc_type of DOC_TYPES)
    await uploadDocument(
      a.id,
      {
        doc_type,
        file: await readFile(
          `fixtures/documents/${doc_type === 'PAN_CARD' ? 'wrong_type_pan' : doc_type.toLowerCase()}.pdf`,
        ),
      },
      merchant,
      mActor(),
    );
  await submit(a.id, merchant, mActor());
  await intake(a.id);
  expect((await state(a.id)).status).toBe('NEEDS_INFO');
  expect(
    (await detail(a.id, merchant)).documents.find((d) => d.doc_type === 'PAN_CARD'),
  ).toMatchObject({ detected_doc_type: 'BANK_PROOF', document_status: 'NEEDS_INFO' });
  await uploadDocument(
    a.id,
    { doc_type: 'PAN_CARD', file: await readFile('fixtures/documents/pan_card.pdf') },
    merchant,
    mActor(),
  );
  await submit(a.id, merchant, mActor());
  const spy = vi.spyOn(extractor, 'extract');
  await intake(a.id);
  expect(spy).toHaveBeenCalledTimes(1);
  const result = await detail(a.id, merchant);
  expect(result.documents.every((d) => d.document_status === 'COMPLETED')).toBe(true);
  expect(result.findings.filter((f) => !f.passed && f.severity === 'BLOCKING')).toEqual([]);
  await finish(a.id);
  await drain();
  expect((await state(a.id)).status).toBe('ACTIVATED');
});

it('persists independent successes and failures, retries only failed documents and recovers', async () => {
  const a = await createApplication(demoForm(), merchant, mActor());
  for (const doc_type of DOC_TYPES)
    await uploadDocument(
      a.id,
      { doc_type, structured_payload: demoDocuments(demoForm())[doc_type] },
      merchant,
      mActor(),
    );
  await submit(a.id, merchant, mActor());
  const original = extractor.extract.bind(extractor);
  const spy = vi.spyOn(extractor, 'extract').mockImplementation(async (doc) => {
    if (doc.doc_type === 'BANK_PROOF') throw new Error('private provider failure');
    return original(doc);
  });
  await expect(intake(a.id)).rejects.toThrow('Document extraction failed');
  const first = await detail(a.id, merchant);
  expect(first.documents.find((d) => d.doc_type === 'BANK_PROOF')).toMatchObject({
    extraction_status: 'FAILED',
    document_status: 'FAILED',
  });
  expect(
    first.documents
      .filter((d) => d.doc_type !== 'BANK_PROOF')
      .every((d) => d.extraction_status === 'COMPLETED'),
  ).toBe(true);
  expect(JSON.stringify(first)).not.toContain('private provider failure');
  expect(await attempts(a.id)).toHaveLength(0);
  spy.mockClear();
  await expect(intake(a.id)).rejects.toThrow();
  expect(spy).toHaveBeenCalledTimes(1);
  spy.mockImplementation(original);
  await intake(a.id);
  expect(
    (await detail(a.id, merchant)).documents.every((d) => d.document_status === 'COMPLETED'),
  ).toBe(true);
  expect(
    (
      await pool.query(
        "SELECT * FROM audit_events WHERE event_type='DOCUMENT_EXTRACTED' AND application_id=$1",
        [a.id],
      )
    ).rowCount,
  ).toBe(3);
  await finish(a.id);
  await drain();
  expect((await state(a.id)).status).toBe('ACTIVATED');
});
it('T-I2 PAN pass / GST fail escalates without dispatching RISK', async () => {
  const id = await create();
  for (const a of await attempts(id))
    await callback(
      a,
      a.check_type === 'GST' ? { status: 'NOT_VERIFIED', reason_code: 'GSTIN_CANCELLED' } : {},
    );
  expect((await state(id)).status).toBe('IN_REVIEW');
  expect(await attempts(id, 'RISK')).toHaveLength(0);
  expect((await detail(id, operator)).exceptions.some((e) => e.type === 'CHECK_FAILED')).toBe(true);
});
it('T-I3 same callback delivered three times applies once', async () => {
  const id = await create(),
    a = (await attempts(id, 'PAN'))[0],
    p = payload(a);
  expect((await receiveCallback('pan', p)).outcome).toBe('APPLIED');
  expect((await receiveCallback('pan', p)).outcome).toBe('DUPLICATE');
  await receiveCallback('pan', p);
  expect(
    (await pool.query('SELECT delivery_count FROM webhook_events')).rows[0].delivery_count,
  ).toBe(3);
  expect(
    (await pool.query("SELECT * FROM audit_events WHERE event_type='CHECK_PASSED'")).rowCount,
  ).toBe(1);
});
it('T-I4 a new event for a completed attempt is ignored', async () => {
  const id = await create(),
    a = (await attempts(id, 'PAN'))[0];
  await callback(a);
  expect((await callback(a)).outcome).toBe('ALREADY_COMPLETED');
});
it('T-I5 a timed-out callback is LATE and its retry succeeds', async () => {
  const id = await create(),
    a = (await attempts(id, 'PAN'))[0];
  await expire(a);
  expect((await callback(a)).outcome).toBe('LATE');
  expect(await attempts(id, 'PAN')).toHaveLength(2);
  await finish(id);
  expect((await state(id)).status).toBe('APPROVED');
});
it('T-I6 timeout exhaustion escalates', async () => {
  const id = await create();
  await expire((await attempts(id, 'PAN'))[0]);
  await expire((await attempts(id, 'PAN'))[1]);
  expect((await state(id)).status).toBe('IN_REVIEW');
  expect((await detail(id, operator)).exceptions.some((e) => e.type === 'CHECK_TIMED_OUT')).toBe(
    true,
  );
});
it('T-I7 bank change preserves PAN/GST and makes old RISK stale', async () => {
  const id = await create();
  for (const a of await attempts(id)) await callback(a);
  const risk = (await attempts(id, 'RISK'))[0];
  const f = demoForm(2);
  await changeBank(
    id,
    f.bank_account!,
    { doc_type: 'BANK_PROOF', structured_payload: demoDocuments(f).BANK_PROOF },
    merchant,
    mActor(),
  );
  expect((await callback(risk)).outcome).toBe('STALE');
  await intake(id);
  const d = await detail(id, operator);
  expect(
    d.checks
      .filter((c) => ['PAN', 'GST'].includes(c.check_type))
      .every((c) => c.status === 'PASSED' && c.attempts.length === 1),
  ).toBe(true);
  expect(d.checks.find((c) => c.check_type === 'BANK').attempts).toHaveLength(2);
});
it('T-I8 approval locks bank changes', async () => {
  const id = await create();
  await finish(id);
  await expect(
    changeBank(id, demoForm(2).bank_account!, undefined, merchant, mActor()),
  ).rejects.toMatchObject({ code: 'APPLICATION_LOCKED' });
});
it('T-I9/T-I10 provisioning exhausts retries then recovers exactly once', async () => {
  const id = await create();
  await finish(id);
  vi.mocked(merchantCore.create).mockRejectedValue(new Error('503'));
  for (let n = 0; n < 4; n++) {
    await pool.query(
      "UPDATE jobs SET run_at=now()-interval '1 second' WHERE status='PENDING' AND type='PROVISION_MERCHANT'",
    );
    await drain();
  }
  expect((await state(id)).status).toBe('PROVISIONING_FAILED');
  expect(
    (await pool.query("SELECT * FROM jobs WHERE status='DEAD' AND type='PROVISION_MERCHANT'"))
      .rowCount,
  ).toBe(1);
  vi.mocked(merchantCore.create).mockResolvedValue({ merchant_id: 'MIDRECOVERED' });
  await operatorAction(id, 'retry', { note: 'Provider is healthy again' }, operator, oActor());
  await drain();
  expect((await state(id)).status).toBe('ACTIVATED');
  expect((await pool.query('SELECT * FROM merchants')).rowCount).toBe(1);
  expect(merchantCore.create).toHaveBeenLastCalledWith(id, demoForm().legal_name);
});
it('T-I11 unreadable PDF requests a specific replacement', async () => {
  const f = demoForm(3, 'Deccan Home Foods'),
    a = await createApplication(f, merchant, mActor());
  const { readFile } = await import('node:fs/promises');
  await uploadDocument(
    a.id,
    { doc_type: 'PAN_CARD', file: await readFile('fixtures/documents/blurred_pan.pdf') },
    merchant,
    mActor(),
  );
  for (const type of ['GST_CERTIFICATE', 'BANK_PROOF'] as const)
    await uploadDocument(
      a.id,
      { doc_type: type, structured_payload: demoDocuments(f)[type] },
      merchant,
      mActor(),
    );
  await submit(a.id, merchant, mActor());
  await intake(a.id);
  expect((await state(a.id)).status).toBe('NEEDS_INFO');
  expect(
    (await detail(a.id, merchant)).info_requests[0].items.some((i: any) => i.target === 'PAN_CARD'),
  ).toBe(true);
  expect(await attempts(a.id)).toHaveLength(0);
});
it('T-I12 confident document conflict blocks verification', async () => {
  const id = await create(demoForm(), (type, p) => {
    if (type === 'PAN_CARD') p.pan_number = demoForm(2).pan;
  });
  expect((await state(id)).status).toBe('NEEDS_INFO');
  expect(
    (await detail(id, merchant)).findings.some((f) => f.rule_code === 'V-DOC-FORM-ID' && !f.passed),
  ).toBe(true);
});
it('T-I13 low confidence proceeds to verification and human review', async () => {
  const a = await createApplication(demoForm(), merchant, mActor());
  const { readFile } = await import('node:fs/promises');
  for (const type of ['PAN_CARD', 'BANK_PROOF'] as const)
    await uploadDocument(
      a.id,
      { doc_type: type, structured_payload: demoDocuments(demoForm())[type] },
      merchant,
      mActor(),
    );
  await uploadDocument(
    a.id,
    {
      doc_type: 'GST_CERTIFICATE',
      file: await readFile('fixtures/documents/low_confidence_gst.pdf'),
    },
    merchant,
    mActor(),
  );
  await submit(a.id, merchant, mActor());
  await intake(a.id);
  expect((await state(a.id)).status).toBe('VERIFYING');
  await finish(a.id);
  expect((await state(a.id)).status).toBe('IN_REVIEW');
});
it('keeps GST review consistent with passed API results and reviewer resolution', async () => {
  const id = await create(demoForm(), (type, payload) => {
    if (type === 'GST_CERTIFICATE') payload.legal_name = 'Kaveri Textiles Limited';
  });
  await finish(id);
  const reviewed = await detail(id, operator);
  expect(reviewed.status).toBe('IN_REVIEW');
  expect(reviewed.verification_summary).toMatchObject({
    cleared: 3,
    provider_passed: 4,
    documents_in_review: 1,
  });
  expect(reviewed.checks.find((c) => c.check_type === 'GST')).toMatchObject({
    status: 'PASSED',
    display_status: 'IN_REVIEW',
  });
  expect(reviewed.documents.find((d) => d.doc_type === 'GST_CERTIFICATE')?.document_status).toBe(
    'IN_REVIEW',
  );
  expect(reviewed.allowed_actions).not.toContain('APPROVE');
  const exception = reviewed.exceptions.find((e) => e.type === 'NAME_MISMATCH')!;
  await operatorAction(
    id,
    'resolve',
    { resolution: 'ACCEPTED', note: 'Reviewed supporting evidence for this name' },
    operator,
    oActor(),
    exception.id,
  );
  const resolved = await detail(id, operator);
  expect(resolved.status).toBe('IN_REVIEW');
  expect(resolved.verification_summary).toMatchObject({ cleared: 4, documents_in_review: 0 });
  expect(resolved.documents.find((d) => d.doc_type === 'GST_CERTIFICATE')?.document_status).toBe(
    'COMPLETED',
  );
  expect(
    resolved.findings.find((f) => f.rule_code === 'V-DOC-NAME' && f.doc_type === 'GST_CERTIFICATE'),
  ).toMatchObject({ passed: false, display_status: 'RESOLVED' });
  expect(resolved.allowed_actions).toContain('APPROVE');
  // A prior decision must not clear the same finding on a later submission.
  await operatorAction(
    id,
    'request-info',
    {
      note: 'Please provide the corrected GST evidence',
      items: [
        {
          code: 'GST_FIX',
          target_type: 'DOCUMENT',
          target: 'GST_CERTIFICATE',
          message: 'Replace the GST document',
        },
      ],
    },
    operator,
    oActor(),
  );
  await submit(id, merchant, mActor());
  await intake(id);
  expect(
    (await detail(id, operator)).documents.find((d) => d.doc_type === 'GST_CERTIFICATE')
      ?.document_status,
  ).toBe('IN_REVIEW');
});
it('rejection closes exceptions and marks only the rejected evidence invalid', async () => {
  const id = await create(demoForm(), (type, fields) => {
    if (type === 'GST_CERTIFICATE') fields.legal_name = 'Kaveri Textiles Limited';
  });
  await finish(id);
  const response = await api.inject({
    method: 'POST',
    url: `/api/v1/applications/${id}/reject`,
    headers: { authorization: `Bearer ${otoken}` },
    payload: {
      reason_code: 'INVALID_DOCUMENTS',
      document_types: ['GST_CERTIFICATE'],
      note: 'GST legal name does not match the declared business.',
    },
  });
  expect(response.statusCode).toBe(200);
  for (const user of [merchant, operator]) {
    const d = await detail(id, user);
    expect(d.status).toBe('REJECTED');
    expect(d.verification_summary).toMatchObject({ open_exceptions: 0, documents_in_review: 0 });
    expect(d.documents.find((x) => x.doc_type === 'GST_CERTIFICATE')?.document_status).toBe(
      'INVALID',
    );
    expect(d.documents.find((x) => x.doc_type === 'PAN_CARD')?.document_status).toBe('COMPLETED');
    expect(d.checks.find((x) => x.check_type === 'GST')).toMatchObject({
      status: 'PASSED',
      display_status: 'INVALID',
    });
    expect(
      d.exceptions.every((x) => x.status === 'CLOSED' && x.resolution === 'APPLICATION_REJECTED'),
    ).toBe(true);
    expect(d.allowed_actions).toEqual([]);
  }
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM application_exceptions WHERE application_id=$1 AND status='OPEN'",
        [id],
      )
    ).rows[0].n,
  ).toBe(0);
});
it('business rejection cancels outstanding review without claiming documents are invalid', async () => {
  const id = await create(demoForm(), (type, fields) => {
    if (type === 'GST_CERTIFICATE') fields.legal_name = 'Different Business';
  });
  await finish(id);
  await operatorAction(
    id,
    'reject',
    {
      reason_code: 'BUSINESS_REQUIREMENTS_NOT_MET',
      note: 'Business category not supported by this merchant programme.',
    },
    operator,
    oActor(),
  );
  const d = await detail(id, merchant);
  expect(d.documents.find((x) => x.doc_type === 'GST_CERTIFICATE')?.document_status).toBe(
    'REJECTED',
  );
  expect(d.documents.some((x) => x.document_status === 'INVALID')).toBe(false);
  expect(d.exceptions.some((x) => x.status === 'OPEN')).toBe(false);
});
it('migration repairs previously rejected applications without accepting their review findings', async () => {
  const id = await create(demoForm(), (type, fields) => {
    if (type === 'GST_CERTIFICATE') fields.legal_name = 'Different Business';
  });
  await finish(id);
  await pool.query(
    "UPDATE applications SET status='REJECTED',rejection_reason_code='INVALID_DOCUMENTS' WHERE id=$1",
    [id],
  );
  const sql = await readFile('apps/api/migrations/002_rejection_closure.sql', 'utf8');
  await pool.query(sql);
  await pool.query(sql);
  const d = await detail(id, merchant);
  expect(d.documents.find((x) => x.doc_type === 'GST_CERTIFICATE')?.document_status).toBe(
    'INVALID',
  );
  expect(d.exceptions.every((x) => x.status === 'CLOSED')).toBe(true);
  expect(
    d.findings.find((x) => x.rule_code === 'V-DOC-NAME' && x.doc_type === 'GST_CERTIFICATE')
      ?.display_status,
  ).toBe('INVALID');
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM audit_events WHERE application_id=$1 AND event_type='EXCEPTION_CLOSED'",
        [id],
      )
    ).rows[0].n,
  ).toBe(1);
});
it('T-I14 guard rejects unresolved exceptions and failed checks', async () => {
  const id = await medium();
  await expect(
    operatorAction(id, 'approve', { note: 'Attempting review approval' }, operator, oActor()),
  ).rejects.toMatchObject({ code: 'APPROVAL_GUARD_FAILED' });
  await pool.query(
    "UPDATE verification_checks SET status='FAILED' WHERE application_id=$1 AND check_type='GST'",
    [id],
  );
  await expect(
    operatorAction(id, 'approve', { note: 'Attempting review approval' }, operator, oActor()),
  ).rejects.toMatchObject({
    details: {
      unmet: expect.arrayContaining([
        expect.objectContaining({ kind: 'CHECK_NOT_PASSED', check_type: 'GST' }),
      ]),
    },
  });
});
it('T-I15 reviewer resolves judgement then approves', async () => {
  const id = await medium(),
    d = await detail(id, operator);
  await operatorAction(
    id,
    'resolve',
    { resolution: 'ACCEPTED', note: 'Evidence checked and accepted' },
    operator,
    oActor(),
    d.exceptions[0].id,
  );
  await operatorAction(id, 'approve', { note: 'All evidence is now checked' }, operator, oActor());
  await drain();
  expect((await state(id)).status).toBe('ACTIVATED');
  expect((await state(id)).approved_by).toBe(operator.id);
});
it('T-I16 corrected GST only reruns GST and RISK', async () => {
  const id = await create();
  for (const a of await attempts(id))
    await callback(a, a.check_type === 'GST' ? { status: 'NOT_VERIFIED' } : {});
  await operatorAction(
    id,
    'request-info',
    {
      note: 'Please correct your GST registration',
      items: [{ code: 'GST_FIX', target_type: 'FIELD', target: 'gstin', message: 'Correct GSTIN' }],
    },
    operator,
    oActor(),
  );
  const f = demoForm();
  const { gstCheck } = await import('../packages/shared/src/index.js');
  const prefix = `27${f.pan}1Z`;
  f.gstin = prefix + gstCheck(prefix);
  await editApplication(id, { gstin: f.gstin }, merchant, mActor());
  await uploadDocument(
    id,
    { doc_type: 'GST_CERTIFICATE', structured_payload: demoDocuments(f).GST_CERTIFICATE },
    merchant,
    mActor(),
  );
  await submit(id, merchant, mActor());
  await intake(id);
  expect(await attempts(id, 'PAN')).toHaveLength(1);
  expect(await attempts(id, 'BANK')).toHaveLength(1);
  expect(await attempts(id, 'GST')).toHaveLength(2);
  await finish(id);
  expect((await state(id)).status).toBe('APPROVED');
});
it('T-I17 callback before dispatch commit stays completed', async () => {
  const id = await create();
  vi.mocked(providers.dispatch).mockImplementation(async (type, attemptId) => {
    const a = (await attempts(id, type)).find((x) => x.id === attemptId);
    await callback(a);
    return { provider_request_id: 'early' };
  });
  await drain();
  expect((await state(id)).status).toBe('ACTIVATED');
  expect((await attempts(id)).every((a) => a.status === 'COMPLETED')).toBe(true);
});
it('T-I18 timeout and callback race leaves one consistent winner', async () => {
  const id = await create(),
    a = (await attempts(id, 'PAN'))[0];
  await pool.query(
    "UPDATE check_attempts SET status='AWAITING_CALLBACK',deadline_at=now()-interval '1 second' WHERE id=$1",
    [a.id],
  );
  await Promise.all([
    callback(a),
    transaction(async (tx) => {
      const app = await lockApp(tx, id);
      const fresh = (await tx.query('SELECT * FROM check_attempts WHERE id=$1', [a.id])).rows[0];
      await timeoutAttempt(tx, app, fresh);
    }),
  ]);
  expect(await attempts(id, 'PAN')).toHaveLength(2);
  expect((await attempts(id, 'PAN'))[0].status).toBe('TIMED_OUT');
});
it('T-I19 unmatched callback is retained', async () => {
  expect(
    (await receiveCallback('pan', payload({ id: randomUUID(), check_type: 'PAN' }))).outcome,
  ).toBe('UNMATCHED');
  expect(
    (await pool.query("SELECT * FROM webhook_events WHERE outcome='UNMATCHED'")).rowCount,
  ).toBe(1);
});
it('T-I20 raw-body HMAC rejects tampering and stale timestamps', async () => {
  const id = await create(),
    p = payload((await attempts(id, 'PAN'))[0]),
    body = JSON.stringify(p);
  for (const timestamp of [
    String(Math.floor(Date.now() / 1000)),
    String(Math.floor(Date.now() / 1000) - 600),
  ]) {
    const res = await api.inject({
      method: 'POST',
      url: '/api/v1/webhooks/providers/pan',
      headers: {
        'content-type': 'application/json',
        'x-provider-timestamp': timestamp,
        'x-provider-signature': signature('pan', timestamp, body),
      },
      payload: timestamp === String(Math.floor(Date.now() / 1000)) ? body + ' ' : body,
    });
    expect(res.statusCode).toBe(401);
  }
  expect((await pool.query('SELECT * FROM webhook_events')).rowCount).toBe(0);
});
it('T-I21 exact duplicates require review', async () => {
  const first = await create();
  await finish(first);
  const actor: Actor = { type: 'MERCHANT', id: other.id };
  const second = await createApplication(demoForm(), other, actor);
  for (const type of DOC_TYPES)
    await uploadDocument(
      second.id,
      { doc_type: type, structured_payload: demoDocuments(demoForm())[type] },
      other,
      actor,
    );
  await submit(second.id, other, actor);
  await intake(second.id);
  const id = second.id;
  await finish(id);
  expect((await state(id)).status).toBe('IN_REVIEW');
  expect(
    (await detail(id, operator)).exceptions.some((e) => e.type === 'DUPLICATE_SUSPECTED'),
  ).toBe(true);
});
it('T-I22 dispatch outage dead-letters and escalates', async () => {
  const id = await create();
  vi.mocked(providers.dispatch).mockRejectedValue(new Error('503'));
  for (let i = 0; i < 4; i++) {
    await pool.query(
      "UPDATE jobs SET run_at=now()-interval '1 second' WHERE type='DISPATCH_CHECK' AND status='PENDING'",
    );
    await drain();
  }
  expect((await state(id)).status).toBe('IN_REVIEW');
  expect(
    (await detail(id, operator)).checks
      .filter((c) => c.check_type !== 'RISK')
      .every((c) => c.status === 'ERROR'),
  ).toBe(true);
});
it('T-J1 retries with increasing backoff and then succeeds', async () => {
  const a = await createApplication(demoForm(), merchant, mActor());
  await transaction((tx) => enqueue(tx, 'INTAKE', a.id));
  const fn = vi
    .fn()
    .mockRejectedValueOnce(new Error())
    .mockRejectedValueOnce(new Error())
    .mockResolvedValue(undefined);
  for (let n = 0; n < 3; n++) {
    await pool.query("UPDATE jobs SET run_at=now()-interval '1 second' WHERE status='PENDING'");
    await runJob((await claimJob())!, fn);
  }
  expect((await pool.query('SELECT * FROM jobs')).rows[0]).toMatchObject({
    attempts: 3,
    status: 'SUCCEEDED',
  });
  expect(backoff(2, 0)).toBeGreaterThan(backoff(1, 0));
});
it('T-J2 dead hook executes once even if stale worker retries completion', async () => {
  const id = await create();
  const a = (await attempts(id, 'PAN'))[0];
  await pool.query("UPDATE jobs SET max_attempts=1 WHERE type='DISPATCH_CHECK'");
  await pool.query("UPDATE jobs SET status='SUCCEEDED' WHERE type='INTAKE'");
  const job = (await claimJob())!;
  const fn = async () => {
    throw new Error();
  };
  await runJob(job, fn);
  await runJob(job, fn);
  expect(
    (await pool.query("SELECT * FROM audit_events WHERE event_type='JOB_DEAD_LETTERED'")).rowCount,
  ).toBe(1);
});
it('T-J3 concurrent claims cannot acquire the same job', async () => {
  const a = await createApplication(demoForm(), merchant, mActor());
  for (let i = 0; i < 6; i++) await transaction((tx) => enqueue(tx, 'INTAKE', a.id));
  const jobs = await Promise.all(Array.from({ length: 6 }, () => claimJob()));
  expect(new Set(jobs.map((j) => j!.id)).size).toBe(6);
});
it('T-J4 stale leases are reclaimed and fenced', async () => {
  const a = await createApplication(demoForm(), merchant, mActor());
  await transaction((tx) => enqueue(tx, 'INTAKE', a.id));
  const old = (await claimJob())!;
  await pool.query("UPDATE jobs SET locked_at=now()-interval '61 seconds'");
  const fresh = (await claimJob())!;
  expect(fresh.lease_token).not.toBe(old.lease_token);
  await runJob(old, async () => {});
  expect((await pool.query('SELECT status FROM jobs')).rows[0].status).toBe('RUNNING');
  await runJob(fresh, async () => {});
  expect((await pool.query('SELECT status FROM jobs')).rows[0].status).toBe('SUCCEEDED');
});
it('T-A1 ownership and T-A2 operator authorization', async () => {
  const id = await create();
  const forbidden = await api.inject({
    url: `/api/v1/applications/${id}`,
    headers: { authorization: `Bearer ${api.jwt.sign(other)}` },
  });
  expect(forbidden.statusCode).toBe(404);
  const action = await api.inject({
    method: 'POST',
    url: `/api/v1/applications/${id}/approve`,
    headers: { authorization: `Bearer ${mtoken}` },
    payload: { note: 'Not an authorized operator' },
  });
  expect(action.statusCode).toBe(403);
});
it('T-A3 API, timeline and stored audit contain no identifiers', async () => {
  const id = await create();
  await finish(id);
  for (const url of [`/api/v1/applications/${id}`, `/api/v1/applications/${id}/timeline`]) {
    const res = await api.inject({ url, headers: { authorization: `Bearer ${otoken}` } });
    expect(res.statusCode).toBe(200);
    for (const value of [
      demoForm().pan!,
      demoForm().gstin!,
      demoForm().bank_account!.account_number,
    ])
      expect(res.body).not.toContain(value);
  }
  const db = JSON.stringify((await pool.query('SELECT data FROM audit_events')).rows);
  expect(db).not.toContain(demoForm().pan!);
});
it('T-A4 rejects disguised executable and oversized file', async () => {
  const a = await createApplication(demoForm(), merchant, mActor());
  await expect(
    uploadDocument(
      a.id,
      { doc_type: 'PAN_CARD', file: Buffer.from('MZ executable'), file_name: 'fake.png' },
      merchant,
      mActor(),
    ),
  ).rejects.toMatchObject({ status: 415 });
  await expect(
    uploadDocument(
      a.id,
      { doc_type: 'PAN_CARD', file: Buffer.alloc(6 * 1024 * 1024) },
      merchant,
      mActor(),
    ),
  ).rejects.toMatchObject({ status: 413 });
});
it('T-D1 database enforces open attempt, merchant and inbox uniqueness', async () => {
  const id = await create(),
    a = (await attempts(id, 'PAN'))[0];
  await expect(
    pool.query(
      'INSERT INTO check_attempts(check_id,application_id,cycle,attempt_no,input_hash) VALUES($1,$2,1,99,$3)',
      [a.check_id, id, a.input_hash],
    ),
  ).rejects.toMatchObject({ code: '23505' });
  await finish(id);
  await drain();
  await expect(
    pool.query(
      "INSERT INTO merchants(application_id,merchant_id,capabilities) VALUES($1,'MIDOTHER','[]')",
      [id],
    ),
  ).rejects.toMatchObject({ code: '23505' });
  const event = (await pool.query('SELECT * FROM webhook_events LIMIT 1')).rows[0];
  await expect(
    pool.query(
      "INSERT INTO webhook_events(provider,event_id,client_reference_id,payload,outcome) VALUES($1,$2,$3,'{}','UNMATCHED')",
      [event.provider, event.event_id, event.client_reference_id],
    ),
  ).rejects.toMatchObject({ code: '23505' });
});
it('cannot resolve a failed required check or overwrite immutable audit', async () => {
  const id = await create();
  await callback((await attempts(id, 'GST'))[0], { status: 'NOT_VERIFIED' });
  const ex = (await detail(id, operator)).exceptions[0];
  await expect(
    operatorAction(
      id,
      'resolve',
      { note: 'Trying to waive this failure', resolution: 'ACCEPTED' },
      operator,
      oActor(),
      ex.id,
    ),
  ).rejects.toMatchObject({ code: 'NOT_RESOLVABLE_BY_REVIEWER' });
  await expect(pool.query("UPDATE audit_events SET event_type='TAMPERED'")).rejects.toThrow(
    'append-only',
  );
});
it('provider mismatch and input hash drift cannot approve', async () => {
  const id = await create(),
    a = (await attempts(id, 'PAN'))[0];
  await expect(receiveCallback('gst', payload(a))).rejects.toMatchObject({
    code: 'PROVIDER_MISMATCH',
  });
  await finish(id, { details: { band: 'MEDIUM', score: 45 } });
  const altered = demoForm(4);
  await pool.query('UPDATE applications SET form_enc=$2 WHERE id=$1', [id, encrypt(altered)]);
  await transaction(async (tx) => {
    const app = await lockApp(tx, id);
    expect((await guard(tx, app)).some((x) => x.kind === 'INPUT_CHANGED')).toBe(true);
  });
});
it('creation idempotency and double submit are safe', async () => {
  const f = demoForm(),
    a = await createApplication(f, merchant, mActor(), 'key');
  expect((await createApplication(f, merchant, mActor(), 'key')).id).toBe(a.id);
  await expect(createApplication(demoForm(2), merchant, mActor(), 'key')).rejects.toMatchObject({
    code: 'IDEMPOTENCY_CONFLICT',
  });
  await submit(a.id, merchant, mActor());
  await expect(submit(a.id, merchant, mActor())).rejects.toMatchObject({
    code: 'INVALID_TRANSITION',
  });
});
it('different keys and repeated new forms cannot create duplicate registrations for one merchant', async () => {
  const form = demoForm();
  const responses = await Promise.all(
    Array.from({ length: 12 }, () =>
      api.inject({
        method: 'POST',
        url: '/api/v1/applications',
        headers: { authorization: `Bearer ${mtoken}`, 'idempotency-key': randomUUID() },
        payload: form,
      }),
    ),
  );
  expect(responses.filter((r) => r.statusCode === 201)).toHaveLength(1);
  expect(responses.filter((r) => r.statusCode === 409)).toHaveLength(11);
  const created = responses.find((r) => r.statusCode === 201)!.json();
  for (const r of responses.filter((r) => r.statusCode === 409)) {
    expect(r.json().error).toMatchObject({
      code: 'APPLICATION_EXISTS',
      details: { application_id: created.id },
    });
  }
  await expect(
    createApplication({ ...form, legal_name: 'Corrected Name' }, merchant, mActor()),
  ).rejects.toMatchObject({ code: 'APPLICATION_EXISTS' });
  expect((await pool.query('SELECT count(*)::int n FROM applications')).rows[0].n).toBe(1);
  // Another merchant must not learn the existing application's ID through this guard.
  expect((await createApplication(form, other, { type: 'MERCHANT', id: other.id })).id).not.toBe(
    created.id,
  );
  // A distinct registration with the same name is not automatically a duplicate.
  expect((await createApplication(demoForm(2), merchant, mActor())).id).not.toBe(created.id);
});

it('metrics aggregates, review queue, policies and dead letters are readable only by operators', async () => {
  const id = await create();
  await finish(id);
  await drain();
  for (const endpoint of [
    'metrics/summary',
    'review-queue',
    'config/check-policies',
    'dead-letters',
  ]) {
    const res = await api.inject({
      url: '/api/v1/' + endpoint,
      headers: { authorization: `Bearer ${otoken}` },
    });
    expect(res.statusCode).toBe(200);
    const forbidden = await api.inject({
      url: '/api/v1/' + endpoint,
      headers: { authorization: `Bearer ${mtoken}` },
    });
    expect(forbidden.statusCode).toBe(403);
  }
  const metrics = (
    await api.inject({
      url: '/api/v1/metrics/summary',
      headers: { authorization: `Bearer ${otoken}` },
    })
  ).json();
  expect(metrics.counts_by_status.ACTIVATED).toBe(1);
  expect(metrics.straight_through_rate).toBe(1);
  expect(metrics.checks).toHaveLength(4);
});
it('valid raw-body signed callback succeeds, including noncanonical whitespace', async () => {
  const id = await create(),
    p = payload((await attempts(id, 'PAN'))[0]),
    body = JSON.stringify(p, null, 2),
    timestamp = String(Math.floor(Date.now() / 1000));
  const res = await api.inject({
    method: 'POST',
    url: '/api/v1/webhooks/providers/pan',
    headers: {
      'content-type': 'application/json',
      'x-provider-timestamp': timestamp,
      'x-provider-signature': signature('pan', timestamp, body),
    },
    payload: body,
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().outcome).toBe('APPLIED');
});
it('reject supersedes in-flight attempts and the terminal application ignores callbacks', async () => {
  const id = await create(),
    all = await attempts(id);
  await callback(
    all.find((a) => a.check_type === 'GST'),
    { status: 'NOT_VERIFIED' },
  );
  await operatorAction(
    id,
    'reject',
    { note: 'Required verification failed conclusively', reason_code: 'VERIFICATION_FAILED' },
    operator,
    oActor(),
  );
  expect((await callback(all.find((a) => a.check_type === 'PAN'))).outcome).toBe('STALE');
  expect((await state(id)).status).toBe('REJECTED');
  await expect(submit(id, merchant, mActor())).rejects.toMatchObject({
    code: 'INVALID_TRANSITION',
  });
});
it('unrecognized fixture exhausts extraction retries and can be reprocessed', async () => {
  const a = await createApplication(demoForm(), merchant, mActor());
  await uploadDocument(
    a.id,
    { doc_type: 'PAN_CARD', file: Buffer.from('%PDF-1.7 unknown fixture') },
    merchant,
    mActor(),
  );
  await submit(a.id, merchant, mActor());
  for (let i = 0; i < 3; i++) {
    await pool.query("UPDATE jobs SET run_at=now()-interval '1 second' WHERE status='PENDING'");
    await drain();
  }
  expect((await state(a.id)).status).toBe('IN_REVIEW');
  expect(
    (await detail(a.id, operator)).exceptions.some((e) => e.type === 'EXTRACTION_FAILED'),
  ).toBe(true);
  await operatorAction(
    a.id,
    'reprocess',
    { note: 'Extraction service has been restored' },
    operator,
    oActor(),
  );
  expect((await state(a.id)).status).toBe('SUBMITTED');
});
it('document access is ownership checked and an authorized view is audited', async () => {
  const id = await create(),
    doc = (await detail(id, merchant)).documents[0];
  const url = `/api/v1/applications/${id}/documents/${doc.id}/content`;
  expect(
    (await api.inject({ url, headers: { authorization: `Bearer ${api.jwt.sign(other)}` } }))
      .statusCode,
  ).toBe(404);
  const res = await api.inject({ url, headers: { authorization: `Bearer ${otoken}` } });
  expect(res.statusCode).toBe(200);
  expect(res.body).not.toContain(demoForm().bank_account!.account_number);
  expect(
    (await pool.query("SELECT * FROM audit_events WHERE event_type='DOCUMENT_VIEWED'")).rowCount,
  ).toBe(1);
});
it('a merchant cannot resubmit a verifying or review application through the submit route', async () => {
  const id = await create();
  await expect(submit(id, merchant, mActor())).rejects.toMatchObject({
    code: 'INVALID_TRANSITION',
  });
  await callback((await attempts(id, 'GST'))[0], { status: 'NOT_VERIFIED' });
  await expect(submit(id, merchant, mActor())).rejects.toMatchObject({
    code: 'INVALID_TRANSITION',
  });
});

it('permanent provider HTTP errors dead-letter without transient retries', async () => {
  const id = await create();
  vi.mocked(providers.dispatch).mockRejectedValue(new ProviderHttpError(400));
  await drain();
  const jobs = (await pool.query("SELECT * FROM jobs WHERE type='DISPATCH_CHECK'")).rows;
  expect(jobs.length).toBe(3);
  expect(jobs.every((j) => j.status === 'DEAD' && j.attempts === 1)).toBe(true);
  expect((await state(id)).status).toBe('IN_REVIEW');
});

it('request correlation follows submission into durable jobs and worker audit', async () => {
  const created = await api.inject({
    method: 'POST',
    url: '/api/v1/applications',
    headers: { authorization: `Bearer ${mtoken}` },
    payload: demoForm(),
  });
  const { id } = created.json();
  const correlation = 'req_submission_trace';
  const res = await api.inject({
    method: 'POST',
    url: `/api/v1/applications/${id}/submit`,
    headers: { authorization: `Bearer ${mtoken}`, 'x-request-id': correlation },
  });
  expect(res.statusCode).toBe(202);
  expect(res.headers['x-request-id']).toBe(correlation);
  const job = (
    await pool.query("SELECT * FROM jobs WHERE application_id=$1 AND type='INTAKE'", [id])
  ).rows[0];
  expect(job.payload.correlation_id).toBe(correlation);
  await pool.query("UPDATE jobs SET run_at=now()-interval '1 second' WHERE id=$1", [job.id]);
  await drain();
  const events = (
    await pool.query(
      "SELECT correlation_id FROM audit_events WHERE application_id=$1 AND actor_type='SYSTEM'",
      [id],
    )
  ).rows;
  expect(events.length).toBeGreaterThan(0);
  expect(events.every((e) => e.correlation_id === correlation)).toBe(true);
});
