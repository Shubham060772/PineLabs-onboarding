import { z } from 'zod';

export const APP_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'EXTRACTING',
  'NEEDS_INFO',
  'VERIFYING',
  'IN_REVIEW',
  'APPROVED',
  'PROVISIONING_FAILED',
  'ACTIVATED',
  'REJECTED',
] as const;
export type AppStatus = (typeof APP_STATUSES)[number];
export const CHECK_TYPES = ['PAN', 'GST', 'BANK', 'RISK'] as const;
export type CheckType = (typeof CHECK_TYPES)[number];
export const DOC_TYPES = ['PAN_CARD', 'GST_CERTIFICATE', 'BANK_PROOF'] as const;
export type DocType = (typeof DOC_TYPES)[number];
// Declared upload slots stay restricted; the extractor can report an unrelated or unidentifiable file.
export const DETECTED_DOC_TYPES = [...DOC_TYPES, 'OTHER', 'UNKNOWN'] as const;
export type DetectedDocType = (typeof DETECTED_DOC_TYPES)[number];
export const OPEN_ATTEMPTS = ['QUEUED', 'AWAITING_CALLBACK'];
export const ATTEMPT_STATUSES = [
  'QUEUED',
  'AWAITING_CALLBACK',
  'COMPLETED',
  'TIMED_OUT',
  'DISPATCH_FAILED',
  'SUPERSEDED',
] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];
export const attemptTransitions: Record<AttemptStatus, readonly AttemptStatus[]> = {
  QUEUED: ['AWAITING_CALLBACK', 'COMPLETED', 'DISPATCH_FAILED', 'SUPERSEDED'],
  AWAITING_CALLBACK: ['COMPLETED', 'TIMED_OUT', 'SUPERSEDED'],
  COMPLETED: [],
  TIMED_OUT: [],
  DISPATCH_FAILED: [],
  SUPERSEDED: [],
};
export function assertAttemptTransition(from: AttemptStatus, to: AttemptStatus) {
  if (!attemptTransitions[from].includes(to))
    throw new AppError(
      'INVALID_ATTEMPT_TRANSITION',
      `Cannot move an attempt from ${from} to ${to}`,
    );
}
export const RESOLVABLE = [
  'LOW_CONFIDENCE_EXTRACTION',
  'NAME_MISMATCH',
  'DUPLICATE_SUSPECTED',
  'RISK_REVIEW',
];
export const transitions: Record<AppStatus, readonly AppStatus[]> = {
  DRAFT: ['SUBMITTED'],
  SUBMITTED: ['EXTRACTING'],
  EXTRACTING: ['NEEDS_INFO', 'VERIFYING', 'IN_REVIEW'],
  NEEDS_INFO: ['SUBMITTED'],
  VERIFYING: ['APPROVED', 'IN_REVIEW', 'SUBMITTED'],
  IN_REVIEW: ['SUBMITTED', 'VERIFYING', 'NEEDS_INFO', 'APPROVED', 'REJECTED'],
  APPROVED: ['ACTIVATED', 'PROVISIONING_FAILED'],
  PROVISIONING_FAILED: ['APPROVED'],
  ACTIVATED: [],
  REJECTED: [],
};
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 409,
    public details: unknown = undefined,
  ) {
    super(message);
  }
}
export function assertTransition(from: AppStatus, to: AppStatus) {
  if (!transitions[from].includes(to))
    throw new AppError('INVALID_TRANSITION', `Cannot move from ${from} to ${to}`);
}
export const text = z.string().trim().max(200);
export const bankSchema = z
  .object({
    account_number: z.string().regex(/^\d{9,18}$/),
    ifsc: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/),
    account_holder_name: text.min(2),
  })
  .strict();
export const formSchema = z
  .object({
    legal_name: text.min(2),
    trade_name: text.optional(),
    business_type: z
      .enum(['PROPRIETORSHIP', 'PARTNERSHIP', 'LLP', 'PRIVATE_LIMITED', 'PUBLIC_LIMITED'])
      .optional(),
    business_category: text.optional(),
    contact_email: z.string().trim().email().max(254),
    contact_phone: text.optional(),
    address_line: text.optional(),
    city: text.optional(),
    state: text.optional(),
    pincode: z
      .string()
      .regex(/^\d{6}$/)
      .optional(),
    pan: z.string().trim().toUpperCase().max(10).optional(),
    gstin: z.string().trim().toUpperCase().max(15).optional(),
    bank_account: bankSchema.optional(),
  })
  .strict();
export type Form = z.infer<typeof formSchema>;
export const fieldSchema = z
  .object({ value: z.string().max(300).nullable(), confidence: z.number().min(0).max(1) })
  .strict();
export const extractionSchema = z
  .object({
    detected_document_type: z.enum(DETECTED_DOC_TYPES),
    legibility: z.enum(['CLEAR', 'DEGRADED', 'UNREADABLE']),
    legibility_issues: z.array(text).max(10).default([]),
    fields: z.record(z.string(), fieldSchema),
  })
  .strict();
export type Extraction = z.infer<typeof extractionSchema>;
export const documentFields: Record<DocType, string[]> = {
  PAN_CARD: ['pan_number', 'name'],
  GST_CERTIFICATE: ['gstin', 'legal_name', 'trade_name'],
  BANK_PROOF: ['account_number', 'ifsc', 'account_holder_name', 'bank_name'],
};
export const structuredSchema = z
  .object({
    doc_type: z.enum(DOC_TYPES),
    structured_payload: z
      .record(z.string(), z.string().max(300))
      .refine((v) => Object.keys(v).length <= 10),
  })
  .strict();
export const infoItemSchema = z
  .object({
    code: text.min(1),
    target_type: z.enum(['FIELD', 'DOCUMENT']),
    target: text.min(1),
    message: text.min(5),
  })
  .strict();
export const noteSchema = z.object({ note: z.string().trim().min(10).max(1000) });
export const callbackSchema = z
  .object({
    event_id: z.string().min(1).max(100),
    client_reference_id: z.string().uuid(),
    provider_request_id: z.string().min(1).max(100),
    status: z.enum(['VERIFIED', 'NOT_VERIFIED', 'ASSESSED']),
    reason_code: z
      .string()
      .regex(/^[A-Z0-9_]{1,80}$/)
      .optional(),
    details: z
      .object({
        score: z.number().min(0).max(100).optional(),
        band: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
        reasons: z.array(text).max(10).optional(),
        registered_name: text.optional(),
        registration_status: text.optional(),
      })
      .strict()
      .default({}),
    occurred_at: z.string().datetime(),
  })
  .strict();
export type Callback = z.infer<typeof callbackSchema>;
export const scenarioSchema = z
  .object({
    target: z.enum(['pan', 'gst', 'bank', 'risk', 'merchant-core']),
    application_id: z.string().uuid().optional(),
    behavior: z.enum([
      'SUCCESS',
      'FAIL',
      'NO_CALLBACK',
      'LATE_CALLBACK',
      'DUPLICATE_CALLBACK',
      'HTTP_503',
      'RISK_BAND',
    ]),
    delay_ms: z.number().int().min(0).max(120000).default(2000),
    times: z.number().int().min(1).max(100).default(1),
    band: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
    reason_code: z
      .string()
      .regex(/^[A-Z0-9_]{1,80}$/)
      .default('VERIFICATION_FAILED'),
    repeats: z.number().int().min(2).max(10).default(3),
  })
  .strict();
export type Scenario = z.infer<typeof scenarioSchema>;
export type User = {
  id: string;
  email: string;
  role: 'MERCHANT' | 'OPERATOR';
  display_name: string;
};
export type Actor = {
  type: 'SYSTEM' | 'MERCHANT' | 'OPERATOR' | 'PROVIDER';
  id?: string;
  correlation_id?: string;
};
export const system: Actor = { type: 'SYSTEM' };
export function normalize(v: string | undefined | null) {
  return (v ?? '').toUpperCase().replace(/\s/g, '');
}
export function mask(v: string | undefined | null) {
  return v ? '*'.repeat(Math.max(4, v.length - 4)) + v.slice(-4) : '';
}
export function gstCheck(prefix: string) {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const n = chars.indexOf(prefix[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(n / 36) + (n % 36);
  }
  return chars[(36 - (sum % 36)) % 36];
}
export const validPan = (v: string) => /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(normalize(v));
export const validGstin = (v: string) => {
  v = normalize(v);
  return (
    /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(v) && gstCheck(v.slice(0, 14)) === v[14]
  );
};
export const validIfsc = (v: string) => /^[A-Z]{4}0[A-Z0-9]{6}$/.test(normalize(v));
export const validAccount = (v: string) => /^\d{9,18}$/.test(v);
export function normalizeName(v: string) {
  return v
    .normalize('NFKC')
    .toUpperCase()
    .replace(/\bPVT\b/g, 'PRIVATE')
    .replace(/\bLTD\b/g, 'LIMITED')
    .replace(/[^\p{L}\p{M}\p{N} ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
export function nameSimilarity(a: string, b: string) {
  const left = normalizeName(a),
    right = normalizeName(b);
  if (!left || !right) return 0;
  const x = new Set(left.split(' ')),
    y = new Set(right.split(' '));
  return (2 * [...x].filter((t) => y.has(t)).length) / (x.size + y.size);
}
export function reconcileField(
  value: string | null,
  declared: string,
  confidence: number,
  readable: boolean,
  valid: boolean,
) {
  if (!readable) return 'UNREADABLE';
  if (!value || confidence < 0.8 || !valid) return 'LOW_CONFIDENCE';
  return normalize(value) === normalize(declared) ? 'MATCH' : 'CONFLICT';
}
export function mapResult(type: CheckType, payload: Callback) {
  if (type === 'RISK') {
    if (
      payload.status !== 'ASSESSED' ||
      payload.details.score === undefined ||
      !payload.details.band
    )
      throw new AppError('INVALID_RESULT', 'Risk requires a score and band', 400);
    // Score is authoritative; the supplied band cannot lower the risk decision.
    const band =
      payload.details.score >= 70 ? 'HIGH' : payload.details.score >= 30 ? 'MEDIUM' : 'LOW';
    if (band !== payload.details.band)
      throw new AppError('INVALID_RESULT', 'Risk score and band disagree', 400);
    return { status: band === 'HIGH' ? 'FAILED' : 'PASSED', review: band === 'MEDIUM' };
  }
  if (payload.status === 'ASSESSED')
    throw new AppError('INVALID_RESULT', 'Identity checks require a verification result', 400);
  return { status: payload.status === 'VERIFIED' ? 'PASSED' : 'FAILED', review: false };
}
