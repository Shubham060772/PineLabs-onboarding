import {
  AppError,
  CHECK_TYPES,
  OPEN_ATTEMPTS,
  type Actor,
  type Callback,
  type CheckType,
  type Extraction,
  system,
  mapResult,
} from '../../../packages/shared/src/index.js';
import {
  audit,
  enqueue,
  formOf,
  lockApp,
  pool,
  transaction,
  transition,
  type Application,
  type Tx,
  changeAttempt,
  supersedeAttempts,
} from './db.js';
import { blind, decrypt, encrypt, inputHash, sanitize } from './crypto.js';
import { extractor } from './extraction.js';
import { validate } from './validation.js';

export async function raiseException(
  tx: Tx,
  app: Application,
  type: string,
  key: string,
  details: unknown = {},
) {
  const row = await tx.query(
    `INSERT INTO application_exceptions(application_id,type,dedupe_key,details) VALUES($1,$2,$3,$4) ON CONFLICT(application_id,dedupe_key) WHERE status='OPEN' DO NOTHING RETURNING id`,
    [app.id, type, key, JSON.stringify(sanitize(details))],
  );
  if (row.rowCount)
    await audit(tx, app.id, 'EXCEPTION_RAISED', system, {
      exception_id: row.rows[0].id,
      type,
      ...sanitize(details as object),
    });
}
export async function closeCheckExceptions(
  tx: Tx,
  app: Application,
  type: CheckType,
  resolution = 'AUTO_CLEARED',
) {
  const { rows } = await tx.query(
    `UPDATE application_exceptions SET status=$3,resolved_at=now(),resolution=$4 WHERE application_id=$1 AND status='OPEN' AND details->>'check_type'=$2 RETURNING id,type`,
    [app.id, type, resolution === 'SUPERSEDED' ? 'SUPERSEDED' : 'RESOLVED', resolution],
  );
  for (const row of rows)
    await audit(tx, app.id, 'EXCEPTION_CLOSED', system, { ...row, resolution });
}
export async function invalidateCheck(tx: Tx, app: Application, check: any, hash: string) {
  await supersedeAttempts(tx, app.id, check.id);
  await tx.query(
    `UPDATE verification_checks SET status='PENDING',cycle=cycle+1,input_hash=$2,result=NULL,reason_code=NULL,completed_at=NULL WHERE id=$1`,
    [check.id, hash],
  );
  await closeCheckExceptions(tx, app, check.check_type, 'SUPERSEDED');
  await audit(tx, app.id, 'CHECK_INVALIDATED', system, {
    check_type: check.check_type,
    cycle: check.cycle + 1,
  });
}
export async function reconcileChecks(tx: Tx, app: Application) {
  const form = formOf(app);
  const { rows: policies } = await tx.query('SELECT * FROM check_policies WHERE enabled');
  for (const p of policies) {
    const hash = inputHash(p.check_type, form);
    const { rows } = await tx.query(
      'SELECT * FROM verification_checks WHERE application_id=$1 AND check_type=$2',
      [app.id, p.check_type],
    );
    if (!rows[0])
      await tx.query(
        'INSERT INTO verification_checks(application_id,check_type,input_hash) VALUES($1,$2,$3)',
        [app.id, p.check_type, hash],
      );
    else if (rows[0].input_hash !== hash) await invalidateCheck(tx, app, rows[0], hash);
  }
}
export async function guard(tx: Tx, app: Application) {
  const unmet: any[] = [];
  const form = formOf(app);
  const { rows } = await tx.query(
    `SELECT p.check_type,c.status,c.input_hash FROM check_policies p LEFT JOIN verification_checks c ON c.check_type=p.check_type AND c.application_id=$1 WHERE p.enabled AND p.required`,
    [app.id],
  );
  for (const c of rows) {
    if (c.status !== 'PASSED')
      unmet.push({
        kind: 'CHECK_NOT_PASSED',
        check_type: c.check_type,
        status: c.status ?? 'MISSING',
      });
    if (c.input_hash !== inputHash(c.check_type, form))
      unmet.push({ kind: 'INPUT_CHANGED', check_type: c.check_type });
  }
  const exceptions = await tx.query(
    "SELECT id FROM application_exceptions WHERE application_id=$1 AND status='OPEN'",
    [app.id],
  );
  for (const ex of exceptions.rows) unmet.push({ kind: 'OPEN_EXCEPTION', exception_id: ex.id });
  return unmet;
}
export async function approve(tx: Tx, app: Application, actor: Actor, note?: string) {
  const unmet = await guard(tx, app);
  if (unmet.length)
    throw new AppError('APPROVAL_GUARD_FAILED', 'Application cannot be approved', 409, { unmet });
  await transition(tx, app, 'APPROVED', actor);
  await tx.query(
    'UPDATE applications SET approved_at=now(),approved_by=$2,decision_note=$3 WHERE id=$1',
    [app.id, actor.type === 'OPERATOR' ? actor.id : null, note ? sanitize(note) : null],
  );
  await audit(tx, app.id, 'APPLICATION_APPROVED', actor, {
    note: note ?? 'All required checks passed',
  });
  await enqueue(tx, 'PROVISION_MERCHANT', app.id, {}, `provision:${app.id}`);
}
export async function newAttempt(tx: Tx, app: Application, check: any) {
  const { rows } = await tx.query(
    `INSERT INTO check_attempts(check_id,application_id,cycle,attempt_no,input_hash) SELECT $1,$2,$3,COALESCE(MAX(attempt_no),0)+1,$4 FROM check_attempts WHERE check_id=$1 RETURNING *`,
    [check.id, app.id, check.cycle, check.input_hash],
  );
  await tx.query("UPDATE verification_checks SET status='IN_PROGRESS' WHERE id=$1", [check.id]);
  await enqueue(tx, 'DISPATCH_CHECK', app.id, { attempt_id: rows[0].id }, `dispatch:${rows[0].id}`);
  await audit(tx, app.id, 'CHECK_ATTEMPT_CREATED', system, {
    check_type: check.check_type,
    attempt_id: rows[0].id,
    attempt_no: rows[0].attempt_no,
  });
}
export async function evaluate(tx: Tx, app: Application) {
  if (app.status !== 'VERIFYING') return;
  const { rows: checks } = await tx.query(
    'SELECT c.*,p.depends_on,p.required FROM verification_checks c JOIN check_policies p USING(check_type) WHERE c.application_id=$1 AND p.enabled',
    [app.id],
  );
  for (const c of checks) {
    if (
      c.status === 'PENDING' &&
      c.depends_on.every((dep: string) =>
        checks.some((x) => x.check_type === dep && x.status === 'PASSED'),
      )
    )
      await newAttempt(tx, app, c);
  }
  const failed = checks.filter(
    (c) => c.required && ['FAILED', 'TIMED_OUT', 'ERROR'].includes(c.status),
  );
  if (failed.length) {
    for (const c of failed) {
      const type =
        c.status === 'FAILED'
          ? 'CHECK_FAILED'
          : c.status === 'TIMED_OUT'
            ? 'CHECK_TIMED_OUT'
            : 'PROVIDER_UNAVAILABLE';
      await raiseException(tx, app, type, `${type}:${c.check_type}`, {
        check_type: c.check_type,
        reason_code: c.reason_code,
      });
    }
    await transition(tx, app, 'IN_REVIEW', system);
    return;
  }
  if (checks.filter((c) => c.required).every((c) => c.status === 'PASSED')) {
    const unmet = await guard(tx, app);
    if (!unmet.length) await approve(tx, app, system);
    else await transition(tx, app, 'IN_REVIEW', system);
  }
}
export async function intake(appId: string) {
  const snapshot = await transaction(async (tx) => {
    const app = await lockApp(tx, appId);
    if (!['SUBMITTED', 'EXTRACTING'].includes(app.status)) return null;
    if (app.status === 'SUBMITTED') await transition(tx, app, 'EXTRACTING', system);
    const { rows: docs } = await tx.query(
      'SELECT * FROM documents WHERE application_id=$1 AND is_active ORDER BY doc_type',
      [app.id],
    );
    return { app, docs };
  });
  if (!snapshot) return;
  let failed = false;
  for (const doc of snapshot.docs) {
    if (doc.extraction_status === 'COMPLETED') {
      continue;
    } else {
      let extraction: Extraction;
      try {
        extraction = await extractor.extract(doc);
      } catch {
        failed = true;
        await transaction(async (tx) => {
          const app = await lockApp(tx, appId);
          if (app.status !== 'EXTRACTING' || app.data_version !== snapshot.app.data_version) return;
          const changed = await tx.query(
            "UPDATE documents SET extraction_status='FAILED' WHERE id=$1 AND is_active AND extraction_status<>'COMPLETED' RETURNING id",
            [doc.id],
          );
          if (changed.rowCount && doc.extraction_status !== 'FAILED')
            await audit(tx, app.id, 'DOCUMENT_EXTRACTION_FAILED', system, {
              document_id: doc.id,
              doc_type: doc.doc_type,
            });
        });
        continue;
      }
      await transaction(async (tx) => {
        const app = await lockApp(tx, appId);
        if (app.status !== 'EXTRACTING' || app.data_version !== snapshot.app.data_version) return;
        const changed = await tx.query(
          `UPDATE documents SET extraction_status='COMPLETED',extractor=$2,legibility=$3,detected_doc_type=$4,extracted_at=now(),extraction_model=$5 WHERE id=$1 AND is_active AND extraction_status<>'COMPLETED' RETURNING id`,
          [
            doc.id,
            doc.source === 'STRUCTURED' ? 'STRUCTURED' : config.extractor.toUpperCase(),
            extraction.legibility,
            extraction.detected_document_type,
            doc.source !== 'FILE'
              ? null
              : config.extractor === 'local'
                ? config.localModel
                : config.extractor === 'llm'
                  ? config.model
                  : null,
          ],
        );
        if (!changed.rowCount) return;
        for (const [name, field] of Object.entries(extraction.fields))
          await tx.query(
            `INSERT INTO extracted_fields(document_id,application_id,field_name,value_enc,confidence,validation) VALUES($1,$2,$3,$4,$5,'PENDING') ON CONFLICT(document_id,field_name) DO UPDATE SET value_enc=excluded.value_enc,confidence=excluded.confidence,validation='PENDING'`,
            [doc.id, app.id, name, encrypt(field.value), field.confidence],
          );
        await audit(tx, app.id, 'DOCUMENT_EXTRACTED', system, {
          document_id: doc.id,
          doc_type: doc.doc_type,
          legibility: extraction.legibility,
          detected_doc_type: extraction.detected_document_type,
        });
      });
    }
  }
  if (failed) throw new Error('Document extraction failed; retry required');
  await transaction(async (tx) => {
    const app = await lockApp(tx, appId);
    if (app.status !== 'EXTRACTING' || app.data_version !== snapshot.app.data_version) return;
    // An overlapping worker may have committed a different response first. Validate
    // only durable evidence under the application lock, never discarded output.
    const { rows: documents } = await tx.query(
      'SELECT * FROM documents WHERE application_id=$1 AND is_active ORDER BY doc_type',
      [app.id],
    );
    const results: Array<{ doc: any; extraction: Extraction }> = [];
    for (const doc of documents) {
      if (doc.extraction_status !== 'COMPLETED')
        throw new Error('Document extraction is incomplete');
      const { rows: fields } = await tx.query(
        'SELECT field_name,value_enc,confidence FROM extracted_fields WHERE document_id=$1',
        [doc.id],
      );
      results.push({
        doc,
        extraction: {
          detected_document_type: doc.detected_doc_type,
          legibility: doc.legibility,
          legibility_issues: [],
          fields: Object.fromEntries(
            fields.map((f) => [
              f.field_name,
              { value: decrypt(f.value_enc), confidence: Number(f.confidence) },
            ]),
          ),
        },
      });
    }
    const form = formOf(app);
    const { findings, validations } = validate(
      form,
      results.map((r) => ({ doc_type: r.doc.doc_type, extraction: r.extraction })),
    );
    // Findings/exceptions belong to this input version. Old document issues cannot block corrected inputs.
    await tx.query('DELETE FROM validation_findings WHERE application_id=$1 AND data_version=$2', [
      app.id,
      app.data_version,
    ]);
    await tx.query(
      `UPDATE application_exceptions SET status='SUPERSEDED',resolution='SUPERSEDED',resolved_at=now() WHERE application_id=$1 AND status='OPEN' AND type IN ('LOW_CONFIDENCE_EXTRACTION','NAME_MISMATCH','EXTRACTION_FAILED','DUPLICATE_SUSPECTED')`,
      [app.id],
    );
    for (const { doc, extraction: e } of results) {
      for (const [name, field] of Object.entries(e.fields))
        await tx.query(
          `INSERT INTO extracted_fields(document_id,application_id,field_name,value_enc,confidence,validation) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(document_id,field_name) DO UPDATE SET value_enc=excluded.value_enc,confidence=excluded.confidence,validation=excluded.validation`,
          [
            doc.id,
            app.id,
            name,
            encrypt(field.value),
            field.confidence,
            validations[doc.doc_type]?.[name] ?? 'INFO',
          ],
        );
    }
    for (const f of findings) {
      await tx.query(
        'INSERT INTO validation_findings(application_id,data_version,rule_code,field_name,doc_type,severity,passed,message) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          app.id,
          app.data_version,
          f.rule_code,
          f.field_name ?? null,
          f.doc_type ?? null,
          f.severity,
          f.passed,
          f.message,
        ],
      );
      if (!f.passed && f.exception_type)
        await raiseException(
          tx,
          app,
          f.exception_type,
          `${f.exception_type}:${f.doc_type}:${f.field_name}`,
          { doc_type: f.doc_type, field_name: f.field_name, message: f.message },
        );
    }
    for (const [field, type] of [
      ['pan_bidx', 'PAN'],
      ['gstin_bidx', 'GSTIN'],
      ['bank_account_bidx', 'BANK_ACCOUNT'],
    ]) {
      const value =
        field === 'pan_bidx'
          ? form.pan
          : field === 'gstin_bidx'
            ? form.gstin
            : form.bank_account?.account_number;
      if (!value) continue;
      const { rows } = await tx.query(
        `SELECT id,reference FROM applications WHERE id<>$1 AND status<>'DRAFT' AND ${field}=$2`,
        [app.id, blind(value)],
      );
      for (const match of rows) {
        await tx.query(
          'INSERT INTO duplicate_matches(application_id,matched_application_id,match_type) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
          [app.id, match.id, type],
        );
        await raiseException(tx, app, 'DUPLICATE_SUSPECTED', `DUPLICATE:${match.id}:${type}`, {
          matched_application_id: match.id,
          reference: match.reference,
          match_type: type,
        });
      }
    }
    const blocking = findings.filter((f) => f.severity === 'BLOCKING' && !f.passed);
    if (blocking.length) {
      const items = blocking.map((f) => ({
        code: f.rule_code,
        target_type: f.doc_type ? 'DOCUMENT' : 'FIELD',
        target: f.doc_type ?? f.field_name,
        message: f.message,
      }));
      await tx.query(
        "INSERT INTO info_requests(application_id,source,items) VALUES($1,'SYSTEM',$2)",
        [app.id, JSON.stringify(items)],
      );
      await audit(tx, app.id, 'INFORMATION_REQUESTED', system, { items });
      await transition(tx, app, 'NEEDS_INFO', system);
    } else {
      await reconcileChecks(tx, app);
      await transition(tx, app, 'VERIFYING', system);
      await evaluate(tx, app);
    }
  });
}
import { config } from './config.js';

export async function timeoutAttempt(tx: Tx, app: Application, attempt: any, now = new Date()) {
  if (
    attempt.status !== 'AWAITING_CALLBACK' ||
    !attempt.deadline_at ||
    new Date(attempt.deadline_at) > now
  )
    return;
  if (!(await changeAttempt(tx, attempt, 'TIMED_OUT', { completed_at: now }))) return;
  const {
    rows: [check],
  } = await tx.query(
    'SELECT c.*,p.max_attempts FROM verification_checks c JOIN check_policies p USING(check_type) WHERE c.id=$1',
    [attempt.check_id],
  );
  await audit(tx, app.id, 'CHECK_ATTEMPT_TIMED_OUT', system, {
    attempt_id: attempt.id,
    check_type: check.check_type,
  });
  const {
    rows: [count],
  } = await tx.query(
    'SELECT count(*)::int AS n FROM check_attempts WHERE check_id=$1 AND cycle=$2',
    [check.id, check.cycle],
  );
  if (count.n < check.max_attempts && ['VERIFYING', 'IN_REVIEW'].includes(app.status)) {
    await newAttempt(tx, app, check);
    await audit(tx, app.id, 'CHECK_RETRY_SCHEDULED', system, { check_type: check.check_type });
  } else {
    await tx.query(
      "UPDATE verification_checks SET status='TIMED_OUT',reason_code='CALLBACK_TIMEOUT' WHERE id=$1",
      [check.id],
    );
    await raiseException(tx, app, 'CHECK_TIMED_OUT', `CHECK_TIMED_OUT:${check.check_type}`, {
      check_type: check.check_type,
    });
    await evaluate(tx, app);
  }
}
export async function receiveCallback(provider: string, payload: Callback) {
  const initial = await pool.query(
    'SELECT a.*,c.check_type FROM check_attempts a JOIN verification_checks c ON c.id=a.check_id WHERE a.id=$1',
    [payload.client_reference_id],
  );
  const found = initial.rows[0];
  if (found && found.check_type.toLowerCase() !== provider)
    throw new AppError('PROVIDER_MISMATCH', 'Callback provider does not match attempt', 400);
  const mapped = mapResult(provider.toUpperCase() as CheckType, payload);
  return transaction(async (tx) => {
    const app = found ? await lockApp(tx, found.application_id) : null;
    const inserted = await tx.query(
      `INSERT INTO webhook_events(provider,event_id,client_reference_id,attempt_id,application_id,payload,outcome) VALUES($1,$2,$3,$4,$5,$6,'UNMATCHED') ON CONFLICT(provider,event_id) DO NOTHING RETURNING id`,
      [
        provider,
        payload.event_id,
        payload.client_reference_id,
        found?.id ?? null,
        app?.id ?? null,
        JSON.stringify({
          status: payload.status,
          reason_code: payload.reason_code,
          score: payload.details.score,
          band: payload.details.band,
        }),
      ],
    );
    if (!inserted.rowCount) {
      const {
        rows: [event],
      } = await tx.query(
        'UPDATE webhook_events SET delivery_count=delivery_count+1,last_received_at=now() WHERE provider=$1 AND event_id=$2 RETURNING *',
        [provider, payload.event_id],
      );
      if (event.delivery_count === 2)
        await audit(
          tx,
          app?.id ?? null,
          'CALLBACK_DUPLICATE_IGNORED',
          { type: 'PROVIDER', id: provider },
          { event_id: payload.event_id },
        );
      return { outcome: 'DUPLICATE' };
    }
    let outcome = 'UNMATCHED';
    if (app) {
      const {
        rows: [attempt],
      } = await tx.query('SELECT * FROM check_attempts WHERE id=$1', [found.id]);
      if (
        attempt.provider_request_id &&
        attempt.provider_request_id !== payload.provider_request_id
      )
        throw new AppError(
          'PROVIDER_REQUEST_MISMATCH',
          'Callback does not match the acknowledged provider request',
          400,
        );
      if (
        attempt.status === 'AWAITING_CALLBACK' &&
        attempt.deadline_at &&
        new Date(attempt.deadline_at) <= new Date()
      ) {
        await timeoutAttempt(tx, app, attempt);
        attempt.status = 'TIMED_OUT';
      }
      if (attempt.status === 'TIMED_OUT') outcome = 'LATE';
      else if (attempt.status === 'SUPERSEDED') outcome = 'STALE';
      else if (attempt.status === 'COMPLETED') outcome = 'ALREADY_COMPLETED';
      else if (!OPEN_ATTEMPTS.includes(attempt.status)) outcome = 'STALE';
      else {
        const {
          rows: [check],
        } = await tx.query('SELECT * FROM verification_checks WHERE id=$1', [attempt.check_id]);
        if (
          check.cycle !== attempt.cycle ||
          check.input_hash !== attempt.input_hash ||
          inputHash(check.check_type, formOf(app)) !== attempt.input_hash ||
          !['VERIFYING', 'IN_REVIEW'].includes(app.status)
        )
          outcome = 'STALE';
        else {
          outcome = 'APPLIED';
          const result = {
            status: payload.status,
            score: payload.details.score,
            band: payload.details.band,
          };
          if (
            !(await changeAttempt(tx, attempt, 'COMPLETED', {
              completed_at: new Date(),
              result,
              provider_request_id: attempt.provider_request_id ?? payload.provider_request_id,
            }))
          )
            throw new Error('Attempt changed despite application lock');
          await tx.query(
            'UPDATE verification_checks SET status=$2,result=$3,reason_code=$4,completed_at=now() WHERE id=$1',
            [check.id, mapped.status, JSON.stringify(result), payload.reason_code ?? null],
          );
          await audit(
            tx,
            app.id,
            `CHECK_${mapped.status}`,
            { type: 'PROVIDER', id: provider },
            {
              check_type: check.check_type,
              attempt_id: attempt.id,
              reason_code: payload.reason_code,
            },
          );
          if (mapped.status === 'PASSED') await closeCheckExceptions(tx, app, check.check_type);
          else
            await raiseException(tx, app, 'CHECK_FAILED', `CHECK_FAILED:${check.check_type}`, {
              check_type: check.check_type,
              reason_code: payload.reason_code ?? 'HIGH_RISK',
            });
          if (mapped.review)
            await raiseException(tx, app, 'RISK_REVIEW', 'RISK_REVIEW:RISK', {
              check_type: 'RISK',
              score: payload.details.score,
              band: payload.details.band,
            });
          await evaluate(tx, app);
        }
      }
    }
    await tx.query('UPDATE webhook_events SET outcome=$2 WHERE id=$1', [
      inserted.rows[0].id,
      outcome,
    ]);
    await audit(
      tx,
      app?.id ?? null,
      outcome === 'APPLIED' ? 'CALLBACK_APPLIED' : `CALLBACK_${outcome}_IGNORED`,
      { type: 'PROVIDER', id: provider },
      { event_id: payload.event_id, attempt_id: found?.id },
    );
    return { outcome };
  });
}
