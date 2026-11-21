import {
  DOC_TYPES,
  validPan,
  validGstin,
  validIfsc,
  validAccount,
  normalize,
  normalizeName,
  reconcileField,
  type Form,
  type DocType,
  type Extraction,
} from '../../../packages/shared/src/index.js';
export type Finding = {
  rule_code: string;
  field_name?: string;
  doc_type?: string;
  severity: 'BLOCKING' | 'REVIEW' | 'INFO';
  passed: boolean;
  message: string;
  exception_type?: string;
};
export function validate(form: Form, docs: Array<{ doc_type: DocType; extraction: Extraction }>) {
  const findings: Finding[] = [];
  const validations: Record<string, Record<string, string>> = {};
  const add = (
    rule_code: string,
    passed: boolean,
    message: string,
    field_name?: string,
    doc_type?: string,
    severity: Finding['severity'] = 'BLOCKING',
    exception_type?: string,
  ) =>
    findings.push({ rule_code, passed, message, field_name, doc_type, severity, exception_type });
  const required: Record<string, unknown> = {
    legal_name: form.legal_name,
    business_type: form.business_type,
    pan: form.pan,
    gstin: form.gstin,
    account_number: form.bank_account?.account_number,
    ifsc: form.bank_account?.ifsc,
    account_holder_name: form.bank_account?.account_holder_name,
    contact_email: form.contact_email,
  };
  for (const [key, value] of Object.entries(required))
    add('V-REQ-FIELD', !!value, `${key.replaceAll('_', ' ')} is required`, key);
  add('V-FMT-PAN', validPan(form.pan ?? ''), 'Provide a valid 10-character PAN', 'pan');
  add(
    'V-FMT-GSTIN',
    validGstin(form.gstin ?? ''),
    'Provide a GSTIN with a valid checksum',
    'gstin',
  );
  add('V-FMT-IFSC', validIfsc(form.bank_account?.ifsc ?? ''), 'Provide a valid IFSC', 'ifsc');
  add(
    'V-FMT-ACCOUNT',
    validAccount(form.bank_account?.account_number ?? ''),
    'Account number must contain 9 to 18 digits',
    'account_number',
  );
  add(
    'V-XREF-GSTIN-PAN',
    !!form.gstin && normalize(form.gstin).slice(2, 12) === normalize(form.pan),
    'GSTIN must contain the declared PAN',
    'gstin',
  );
  const expectedEntity =
    form.business_type === 'PROPRIETORSHIP'
      ? 'P'
      : ['LLP', 'PARTNERSHIP'].includes(form.business_type ?? '')
        ? 'F'
        : 'C';
  add(
    'V-PAN-ENTITY',
    form.pan?.[3] === expectedEntity,
    'PAN entity character should match the business type',
    'pan',
    undefined,
    'INFO',
  );
  for (const type of DOC_TYPES) {
    const doc = docs.find((d) => d.doc_type === type);
    add('V-REQ-DOC', !!doc, `Upload ${type.replaceAll('_', ' ').toLowerCase()}`, undefined, type);
    if (!doc) continue;
    const e = doc.extraction,
      readable = e.legibility !== 'UNREADABLE' && e.detected_document_type === type;
    const supported =
      e.detected_document_type !== 'OTHER' && e.detected_document_type !== 'UNKNOWN';
    add(
      'V-DOC-TYPE',
      supported && e.detected_document_type === type,
      e.detected_document_type === type
        ? 'Document type matches the requested upload.'
        : e.detected_document_type === 'OTHER'
          ? `This file is unrelated to ${type.replaceAll('_', ' ')}. Upload the correct document.`
          : e.detected_document_type === 'UNKNOWN'
            ? `The document type could not be identified. Upload a clear ${type.replaceAll('_', ' ')}.`
            : `Expected ${type.replaceAll('_', ' ')}, but detected ${e.detected_document_type.replaceAll('_', ' ')}. Upload the correct document.`,
      undefined,
      type,
    );
    validations[type] = {};
    if (!supported || e.detected_document_type !== type) {
      for (const key of Object.keys(e.fields)) validations[type][key] = 'WRONG_DOCUMENT_TYPE';
      continue;
    }
    add(
      'V-DOC-LEGIBLE',
      readable,
      `${type.replaceAll('_', ' ')} is unreadable or the wrong document type; upload a clearer, correct copy`,
      undefined,
      type,
    );
    validations[type] = {};
    const identifiers: Record<string, [string, (v: string) => boolean]> = {
      pan_number: [form.pan ?? '', validPan],
      gstin: [form.gstin ?? '', validGstin],
      account_number: [form.bank_account?.account_number ?? '', validAccount],
      ifsc: [form.bank_account?.ifsc ?? '', validIfsc],
    };
    for (const [key, field] of Object.entries(e.fields)) {
      if (identifiers[key]) {
        const [declared, validator] = identifiers[key];
        if (field.value && !validator(field.value))
          field.confidence = Math.min(field.confidence, 0.5);
        const status = reconcileField(
          field.value,
          declared,
          e.legibility === 'DEGRADED' ? Math.min(field.confidence, 0.79) : field.confidence,
          readable,
          !!field.value && validator(field.value),
        );
        validations[type][key] = status;
        add(
          'V-DOC-FORM-ID',
          status !== 'CONFLICT',
          `${key.replaceAll('_', ' ')} on the document conflicts with the form; correct the form or replace the document`,
          key,
          type,
        );
        add(
          'V-DOC-CONF',
          status !== 'LOW_CONFIDENCE',
          `${key.replaceAll('_', ' ')} requires reviewer confirmation`,
          key,
          type,
          'REVIEW',
          'LOW_CONFIDENCE_EXTRACTION',
        );
      } else if (['name', 'legal_name', 'account_holder_name'].includes(key)) {
        const expected =
          key === 'account_holder_name'
            ? (form.bank_account?.account_holder_name ?? '')
            : form.legal_name;
        const extractedName = normalizeName(field.value ?? '');
        // Similarity alone can hide missing legal-name words such as PRIVATE.
        const matched = !!extractedName && extractedName === normalizeName(expected);
        const confident = readable && e.legibility === 'CLEAR' && field.confidence >= 0.8;
        add(
          'V-DOC-CONF',
          confident,
          `${key.replaceAll('_', ' ')} requires reviewer confirmation`,
          key,
          type,
          'REVIEW',
          'LOW_CONFIDENCE_EXTRACTION',
        );
        add(
          'V-DOC-NAME',
          matched,
          'The document name needs reviewer confirmation',
          key,
          type,
          'REVIEW',
          'NAME_MISMATCH',
        );
        validations[type][key] = matched && confident ? 'MATCH' : 'LOW_CONFIDENCE';
      } else validations[type][key] = 'INFO';
    }
  }
  return { findings, validations };
}
