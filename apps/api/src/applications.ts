import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  AppError,
  RESOLVABLE,
  CHECK_TYPES,
  DOC_TYPES,
  documentFields,
  mask,
  system,
  type Actor,
  type User,
  type Form,
  type DocType,
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
  supersedeAttempts,
} from './db.js';
import { blind, decrypt, encrypt, inputHash, sanitize, sha } from './crypto.js';
import { approve, guard, reconcileChecks, evaluate, invalidateCheck } from './workflow.js';
import { config } from './config.js';

export function authorize(app: Application, user: User, merchantOnly = false) {
  if (user.role === 'MERCHANT' && app.owner_user_id !== user.id)
    throw new AppError('NOT_FOUND', 'Application not found', 404);
  if (merchantOnly && user.role !== 'MERCHANT')
    throw new AppError('FORBIDDEN', 'Only the merchant can change application data', 403);
}
export async function saveForm(tx: Tx, app: Application, form: Form) {
  const enc = encrypt(form);
  await tx.query(
    'UPDATE applications SET form_enc=$2,legal_name=$3,pan_bidx=$4,gstin_bidx=$5,bank_account_bidx=$6 WHERE id=$1',
    [
      app.id,
      enc,
      form.legal_name,
      form.pan ? blind(form.pan) : null,
      form.gstin ? blind(form.gstin) : null,
      form.bank_account ? blind(form.bank_account.account_number) : null,
    ],
  );
  app.form_enc = enc;
  app.legal_name = form.legal_name;
}
export async function createApplication(form: Form, user: User, actor: Actor, key?: string) {
  if (user.role !== 'MERCHANT')
    throw new AppError('FORBIDDEN', 'Only merchants can create applications', 403);
  return transaction(async (tx) => {
    const requestHash = sha(JSON.stringify(form));
    if (key) {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${user.id}:${key}`]);
      const prior = await tx.query(
        'SELECT * FROM applications WHERE owner_user_id=$1 AND idempotency_key=$2',
        [user.id, key],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].request_hash !== requestHash)
          throw new AppError('IDEMPOTENCY_CONFLICT', 'This key was used with different input');
        return summary(prior.rows[0]);
      }
    }
    const {
      rows: [app],
    } = await tx.query(
      'INSERT INTO applications(owner_user_id,legal_name,form_enc,pan_bidx,gstin_bidx,bank_account_bidx,idempotency_key,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [
        user.id,
        form.legal_name,
        encrypt(form),
        form.pan ? blind(form.pan) : null,
        form.gstin ? blind(form.gstin) : null,
        form.bank_account ? blind(form.bank_account.account_number) : null,
        key ?? null,
        requestHash,
      ],
    );
    await audit(tx, app.id, 'APPLICATION_CREATED', actor);
    return summary(app);
  });
}
export const summary = (app: Application) =>
  sanitize({
    id: app.id,
    reference: app.reference,
    legal_name: app.legal_name,
    status: app.status,
    status_changed_at: app.status_changed_at,
    created_at: app.created_at,
    open_exceptions: Number(app.open_exceptions ?? 0),
  });
export async function allowedActions(tx: Tx, app: Application, user: User) {
  if (user.role === 'MERCHANT')
    return ['DRAFT', 'NEEDS_INFO'].includes(app.status)
      ? ['EDIT', 'UPLOAD', 'SUBMIT']
      : ['VERIFYING', 'IN_REVIEW'].includes(app.status)
        ? ['CHANGE_BANK']
        : [];
  if (app.status === 'PROVISIONING_FAILED') return ['RETRY_PROVISIONING'];
  if (app.status !== 'IN_REVIEW') return [];
  const result = ['REQUEST_INFO', 'REJECT'];
  if (!(await guard(tx, app)).length) result.push('APPROVE');
  const { rows } = await tx.query(
    "SELECT check_type FROM verification_checks WHERE application_id=$1 AND status IN ('FAILED','TIMED_OUT','ERROR')",
    [app.id],
  );
  result.push(...rows.map((r) => `RERUN_CHECK:${r.check_type}`));
  if (
    (
      await tx.query(
        "SELECT 1 FROM application_exceptions WHERE application_id=$1 AND type='EXTRACTION_FAILED' AND status='OPEN'",
        [app.id],
      )
    ).rowCount
  )
    result.push('REPROCESS');
  return result;
}
export async function detail(id: string, user: User) {
  return transaction(async (tx) => {
    // A consistent snapshot keeps allowed_actions and the displayed checks in agreement.
    const app = await lockApp(tx, id);
    authorize(app, user);
    const f = formOf(app);
    const { rows: docs } = await tx.query(
      'SELECT id,doc_type,source,file_name,mime_type,extraction_status,extractor,extraction_model,detected_doc_type,legibility,is_active,created_at FROM documents WHERE application_id=$1 AND is_active ORDER BY doc_type',
      [id],
    );
    for (const doc of docs) {
      const { rows } = await tx.query(
        'SELECT field_name,value_enc,confidence,validation FROM extracted_fields WHERE document_id=$1 ORDER BY field_name',
        [doc.id],
      );
      doc.fields = rows.map((field) => ({
        field_name: field.field_name,
        value_masked: ['pan_number', 'gstin', 'account_number'].includes(field.field_name)
          ? mask(decrypt(field.value_enc))
          : sanitize(decrypt(field.value_enc)),
        confidence: Number(field.confidence),
        validation: field.validation,
      }));
    }
    const { rows: checks } = await tx.query(
      'SELECT c.*,p.depends_on FROM verification_checks c JOIN check_policies p USING(check_type) WHERE c.application_id=$1 ORDER BY c.check_type',
      [id],
    );
    for (const c of checks) {
      delete c.input_hash;
      c.blocked_by = c.depends_on.filter(
        (d: string) => !checks.some((x) => x.check_type === d && x.status === 'PASSED'),
      );
      const attempts = await tx.query(
        'SELECT id,cycle,attempt_no,status,provider_request_id,dispatched_at,deadline_at,completed_at,created_at FROM check_attempts WHERE check_id=$1 ORDER BY attempt_no',
        [c.id],
      );
      c.attempts = attempts.rows;
      for (const attempt of c.attempts) {
        const events = await tx.query(
          'SELECT event_id,outcome,delivery_count,first_received_at,last_received_at FROM webhook_events WHERE attempt_id=$1 ORDER BY first_received_at',
          [attempt.id],
        );
        attempt.callbacks = events.rows;
      }
    }
    const { rows: exceptions } = await tx.query(
      'SELECT * FROM application_exceptions WHERE application_id=$1 ORDER BY raised_at DESC',
      [id],
    );
    const { rows: requests } = await tx.query(
      'SELECT * FROM info_requests WHERE application_id=$1 ORDER BY created_at DESC',
      [id],
    );
    const { rows: findings } = await tx.query(
      'SELECT rule_code,field_name,doc_type,severity,passed,message FROM validation_findings WHERE application_id=$1 AND data_version=$2',
      [id, app.data_version],
    );
    const { rows: merchants } = await tx.query(
      'SELECT merchant_id,capabilities,provisioned_at FROM merchants WHERE application_id=$1',
      [id],
    );
    for (const doc of docs) {
      const issues = findings.filter((f) => f.doc_type === doc.doc_type && !f.passed);
      const blocking = issues.find((f) => f.severity === 'BLOCKING');
      const wrongType = doc.detected_doc_type && doc.detected_doc_type !== doc.doc_type;
      doc.document_status = doc.extraction_status;
      doc.status_message = 'Waiting for document extraction.';
      if (doc.extraction_status === 'FAILED') {
        doc.status_message =
          app.status === 'EXTRACTING'
            ? 'Extraction failed. Automatic retries are in progress.'
            : 'Extraction failed. A reviewer can reprocess or request a replacement document.';
      } else if (doc.extraction_status === 'PENDING' && app.status === 'EXTRACTING') {
        doc.document_status = 'EXTRACTING';
        doc.status_message = 'Document extraction is in progress.';
      } else if (doc.extraction_status === 'COMPLETED') {
        doc.document_status =
          wrongType || blocking
            ? 'NEEDS_INFO'
            : issues.some((f) => f.severity === 'REVIEW')
              ? 'IN_REVIEW'
              : 'COMPLETED';
        doc.status_message =
          blocking?.message ??
          (wrongType
            ? `Detected ${doc.detected_doc_type}. Upload the correct ${doc.doc_type.replaceAll('_', ' ')} document.`
            : (issues.find((f) => f.severity === 'REVIEW')?.message ??
              (!findings.some((f) => f.doc_type === doc.doc_type)
                ? 'Extraction completed. Waiting for the remaining documents before validation.'
                : 'Extraction and document validation completed.')));
      }
    }
    const form = {
      ...f,
      pan: undefined,
      gstin: undefined,
      bank_account: undefined,
      pan_masked: mask(f.pan),
      gstin_masked: mask(f.gstin),
      bank_account_masked: mask(f.bank_account?.account_number),
      bank_ifsc: f.bank_account?.ifsc,
      bank_account_holder_name: f.bank_account?.account_holder_name,
    };
    return sanitize({
      ...summary(app),
      data_version: app.data_version,
      form,
      documents: docs,
      checks,
      exceptions: exceptions.map((e) => ({
        ...e,
        reviewer_resolvable: RESOLVABLE.includes(e.type),
      })),
      info_requests: requests,
      findings,
      merchant: merchants[0] ?? null,
      approved_at: app.approved_at,
      approved_by: app.approved_by,
      allowed_actions: await allowedActions(tx, app, user),
    });
  });
}
export async function editApplication(id: string, patch: Partial<Form>, user: User, actor: Actor) {
  return transaction(async (tx) => {
    const app = await lockApp(tx, id);
    authorize(app, user, true);
    if (!['DRAFT', 'NEEDS_INFO'].includes(app.status))
      throw new AppError(
        'INVALID_STATE',
        'Application can only be edited in draft or while information is requested',
      );
    await saveForm(tx, app, { ...formOf(app), ...patch });
    await audit(tx, id, 'APPLICATION_EDITED', actor, { fields: Object.keys(patch) });
    return summary(app);
  });
}
export async function submit(id: string, user: User, actor: Actor) {
  return transaction(async (tx) => {
    const app = await lockApp(tx, id);
    authorize(app, user, true);
    if (!['DRAFT', 'NEEDS_INFO'].includes(app.status))
      throw new AppError(
        'INVALID_TRANSITION',
        'Submit is only allowed for drafts and requested corrections',
      );
    await transition(tx, app, 'SUBMITTED', actor);
    await tx.query(
      'UPDATE applications SET data_version=data_version+1,submitted_at=COALESCE(submitted_at,now()) WHERE id=$1',
      [id],
    );
    await tx.query(
      "UPDATE info_requests SET status='FULFILLED',fulfilled_at=now() WHERE application_id=$1 AND status='OPEN'",
      [id],
    );
    await enqueue(tx, 'INTAKE', id, {}, `intake:${id}:${app.data_version + 1}`);
    await audit(tx, id, 'APPLICATION_SUBMITTED', actor, { data_version: app.data_version + 1 });
    return { id, status: app.status };
  });
}
export type Upload = {
  doc_type: DocType;
  structured_payload?: Record<string, string>;
  file?: Buffer;
  file_name?: string;
};
export function detectMime(buffer: Buffer) {
  if (buffer.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png';
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'image/jpeg';
  throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Upload a PDF, PNG or JPEG document', 415);
}
export async function storeDocument(
  tx: Tx,
  app: Application,
  input: Upload,
  user: User,
  actor: Actor,
) {
  if (!DOC_TYPES.includes(input.doc_type))
    throw new AppError('VALIDATION_ERROR', 'Invalid document type', 400);
  const id = randomUUID();
  let mime: string | null = null,
    storageKey: string | null = null,
    hash: string | null = null;
  if (input.file) {
    if (input.file.length > 5 * 1024 * 1024)
      throw new AppError('FILE_TOO_LARGE', 'Documents must be at most 5 MB', 413);
    mime = detectMime(input.file);
    hash = sha(input.file);
    storageKey = `${app.id}/${hash}`;
    await mkdir(path.join(config.storage, app.id), { recursive: true });
    await writeFile(path.join(config.storage, storageKey), input.file, { mode: 0o600 });
  } else {
    if (
      !input.structured_payload ||
      Object.keys(input.structured_payload).some((k) => !documentFields[input.doc_type].includes(k))
    )
      throw new AppError(
        'VALIDATION_ERROR',
        'Structured document contains unsupported fields',
        400,
      );
  }
  await tx.query(
    'UPDATE documents SET is_active=false WHERE application_id=$1 AND doc_type=$2 AND is_active',
    [app.id, input.doc_type],
  );
  await tx.query(
    'INSERT INTO documents(id,application_id,doc_type,source,file_name,mime_type,size_bytes,sha256,storage_key,payload_enc,uploaded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
    [
      id,
      app.id,
      input.doc_type,
      input.file ? 'FILE' : 'STRUCTURED',
      input.file
        ? `${input.doc_type}.${mime === 'application/pdf' ? 'pdf' : mime === 'image/png' ? 'png' : 'jpg'}`
        : null,
      mime,
      input.file?.length ?? null,
      hash,
      storageKey,
      input.structured_payload ? encrypt(input.structured_payload) : null,
      user.id,
    ],
  );
  await audit(tx, app.id, 'DOCUMENT_UPLOADED', actor, {
    document_id: id,
    doc_type: input.doc_type,
    source: input.file ? 'FILE' : 'STRUCTURED',
  });
  return { id, doc_type: input.doc_type, extraction_status: 'PENDING' };
}
export async function uploadDocument(id: string, input: Upload, user: User, actor: Actor) {
  return transaction(async (tx) => {
    const app = await lockApp(tx, id);
    authorize(app, user, true);
    if (!['DRAFT', 'NEEDS_INFO'].includes(app.status))
      throw new AppError(
        'INVALID_STATE',
        'Documents can only be uploaded in draft or when information is requested',
      );
    return storeDocument(tx, app, input, user, actor);
  });
}
export async function documentContent(id: string, docId: string, user: User, actor: Actor) {
  return transaction(async (tx) => {
    const app = await lockApp(tx, id);
    authorize(app, user);
    const {
      rows: [doc],
    } = await tx.query('SELECT * FROM documents WHERE id=$1 AND application_id=$2', [docId, id]);
    if (!doc) throw new AppError('NOT_FOUND', 'Document not found', 404);
    await audit(tx, id, 'DOCUMENT_VIEWED', actor, { document_id: docId });
    if (doc.source === 'FILE')
      return {
        mime: doc.mime_type,
        content: await readFile(path.join(config.storage, doc.storage_key)),
      };
    const fields = decrypt<Record<string, string>>(doc.payload_enc);
    return {
      mime: 'application/json',
      content: Buffer.from(
        JSON.stringify(
          Object.fromEntries(
            Object.entries(fields).map(([k, v]) => [
              k,
              ['pan_number', 'gstin', 'account_number'].includes(k) ? mask(v) : sanitize(v),
            ]),
          ),
          null,
          2,
        ),
      ),
    };
  });
}
export async function changeBank(
  id: string,
  bank: NonNullable<Form['bank_account']>,
  proof: Upload | undefined,
  user: User,
  actor: Actor,
) {
  return transaction(async (tx) => {
    const app = await lockApp(tx, id);
    authorize(app, user, true);
    if (['APPROVED', 'PROVISIONING_FAILED', 'ACTIVATED'].includes(app.status))
      throw new AppError('APPLICATION_LOCKED', 'Bank details are locked after approval');
    if (['SUBMITTED', 'EXTRACTING'].includes(app.status))
      throw new AppError('APPLICATION_BUSY', 'Wait for document processing to finish');
    if (!['VERIFYING', 'IN_REVIEW'].includes(app.status))
      throw new AppError('INVALID_STATE', 'Use the application editor in this state');
    const form = formOf(app),
      old = mask(form.bank_account?.account_number);
    form.bank_account = bank;
    await saveForm(tx, app, form);
    await reconcileChecks(tx, app);
    if (proof) await storeDocument(tx, app, proof, user, actor);
    await transition(tx, app, 'SUBMITTED', actor);
    await tx.query('UPDATE applications SET data_version=data_version+1 WHERE id=$1', [id]);
    await audit(tx, id, 'BANK_DETAILS_CHANGED', actor, {
      old_last4: old,
      new_last4: mask(bank.account_number),
    });
    await enqueue(tx, 'INTAKE', id, {}, `intake:${id}:${app.data_version + 1}`);
    return { id, status: app.status, invalidated_checks: ['BANK', 'RISK'] };
  });
}
export async function operatorAction(
  id: string,
  action: string,
  body: any,
  user: User,
  actor: Actor,
  param?: string,
) {
  if (user.role !== 'OPERATOR') throw new AppError('FORBIDDEN', 'Operator role required', 403);
  return transaction(async (tx) => {
    const app = await lockApp(tx, id);
    if (action === 'retry') {
      if (app.status !== 'PROVISIONING_FAILED')
        throw new AppError('INVALID_TRANSITION', 'Provisioning can only be retried after failure');
      await transition(tx, app, 'APPROVED', actor);
      await tx.query(
        "UPDATE application_exceptions SET status='RESOLVED',resolution='AUTO_CLEARED',resolved_at=now() WHERE application_id=$1 AND type='PROVISIONING_FAILED' AND status='OPEN'",
        [id],
      );
      await enqueue(tx, 'PROVISION_MERCHANT', id, {}, `provision:${id}`);
    } else {
      if (app.status !== 'IN_REVIEW')
        throw new AppError('INVALID_TRANSITION', 'This action requires an application in review');
      if (action === 'approve') await approve(tx, app, actor, body.note);
      else if (action === 'resolve') {
        const {
          rows: [ex],
        } = await tx.query(
          "SELECT * FROM application_exceptions WHERE id=$1 AND application_id=$2 AND status='OPEN'",
          [param, id],
        );
        if (!ex) throw new AppError('NOT_FOUND', 'Open exception not found', 404);
        if (!RESOLVABLE.includes(ex.type))
          throw new AppError(
            'NOT_RESOLVABLE_BY_REVIEWER',
            'A failed required check cannot be waived',
          );
        await tx.query(
          "UPDATE application_exceptions SET status='RESOLVED',resolution=$2,resolution_note=$3,resolved_at=now(),resolved_by=$4 WHERE id=$1",
          [ex.id, body.resolution, sanitize(body.note), user.id],
        );
        await audit(tx, id, 'EXCEPTION_RESOLVED', actor, {
          exception_id: ex.id,
          note: body.note,
          resolution: body.resolution,
        });
      } else if (action === 'reject' || action === 'request-info') {
        await supersedeAttempts(tx, id);
        await tx.query(
          "UPDATE verification_checks SET status='PENDING' WHERE application_id=$1 AND status='IN_PROGRESS'",
          [id],
        );
        if (action === 'reject') {
          await transition(tx, app, 'REJECTED', actor);
          await tx.query(
            'UPDATE applications SET decision_note=$2,rejection_reason_code=$3 WHERE id=$1',
            [id, sanitize(body.note), body.reason_code],
          );
          await tx.query(
            "UPDATE info_requests SET status='CANCELLED' WHERE application_id=$1 AND status='OPEN'",
            [id],
          );
        } else {
          await tx.query(
            "INSERT INTO info_requests(application_id,source,requested_by,items,note) VALUES($1,'OPERATOR',$2,$3,$4)",
            [id, user.id, JSON.stringify(sanitize(body.items)), sanitize(body.note)],
          );
          await audit(tx, id, 'INFORMATION_REQUESTED', actor, {
            items: body.items,
            note: body.note,
          });
          await transition(tx, app, 'NEEDS_INFO', actor);
        }
      } else if (action === 'rerun') {
        const {
          rows: [check],
        } = await tx.query(
          'SELECT * FROM verification_checks WHERE application_id=$1 AND check_type=$2',
          [id, param],
        );
        if (!check || !['FAILED', 'TIMED_OUT', 'ERROR'].includes(check.status))
          throw new AppError(
            'INVALID_STATE',
            'Only a failed, timed out or errored check can be rerun',
          );
        await invalidateCheck(tx, app, check, inputHash(check.check_type, formOf(app)));
        if (param !== 'RISK') {
          const {
            rows: [risk],
          } = await tx.query(
            "SELECT * FROM verification_checks WHERE application_id=$1 AND check_type='RISK'",
            [id],
          );
          if (risk) await invalidateCheck(tx, app, risk, inputHash('RISK', formOf(app)));
        }
        await transition(tx, app, 'VERIFYING', actor);
        await evaluate(tx, app);
      } else if (action === 'reprocess') {
        const failed = await tx.query(
          "SELECT 1 FROM application_exceptions WHERE application_id=$1 AND type='EXTRACTION_FAILED' AND status='OPEN'",
          [id],
        );
        if (!failed.rowCount)
          throw new AppError('INVALID_STATE', 'There is no extraction failure to reprocess');
        await tx.query(
          "UPDATE documents SET extraction_status='PENDING' WHERE application_id=$1 AND is_active AND extraction_status='FAILED'",
          [id],
        );
        await transition(tx, app, 'SUBMITTED', actor);
        await tx.query('UPDATE applications SET data_version=data_version+1 WHERE id=$1', [id]);
        await enqueue(tx, 'INTAKE', id, {}, `intake:${id}:${app.data_version + 1}`);
      } else throw new AppError('NOT_FOUND', 'Unknown action', 404);
    }
    await audit(tx, id, `OPERATOR_${action.toUpperCase().replaceAll('-', '_')}`, actor, {
      note: body.note,
      check_type: param && CHECK_TYPES.includes(param as any) ? param : undefined,
    });
    return { id, status: app.status };
  });
}
