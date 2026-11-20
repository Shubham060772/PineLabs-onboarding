import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { config } from './config.js';
import {
  normalize,
  normalizeName,
  type CheckType,
  type Form,
} from '../../../packages/shared/src/index.js';
export function encrypt(value: unknown) {
  const key = Buffer.from(config.encryptionKey, 'hex');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY must be 64 hex characters');
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}
export function decrypt<T = any>(value: string): T {
  const bytes = Buffer.from(value, 'base64'),
    decipher = createDecipheriv(
      'aes-256-gcm',
      Buffer.from(config.encryptionKey, 'hex'),
      bytes.subarray(0, 12),
    );
  decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'),
  );
}
export const blind = (v: string) =>
  createHmac('sha256', config.blindKey).update(normalize(v)).digest('hex');
export const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
export function inputHash(type: CheckType, f: Form) {
  const bank = f.bank_account;
  const inputs: Record<CheckType, unknown[]> = {
    PAN: [normalize(f.pan), normalizeName(f.legal_name)],
    GST: [normalize(f.gstin), normalizeName(f.legal_name)],
    BANK: [
      bank?.account_number,
      normalize(bank?.ifsc),
      normalizeName(bank?.account_holder_name ?? ''),
    ],
    RISK: [
      normalize(f.pan),
      normalize(f.gstin),
      bank?.account_number,
      normalize(bank?.ifsc),
      normalizeName(bank?.account_holder_name ?? ''),
      f.business_category,
      f.pincode,
    ],
  };
  return sha(JSON.stringify(inputs[type]));
}
export const signature = (provider: string, timestamp: string, body: string) =>
  createHmac('sha256', config.webhookSecret(provider)).update(`${timestamp}.${body}`).digest('hex');
export function verifySignature(
  provider: string,
  timestamp: string,
  body: string,
  supplied: string,
  now = Date.now(),
) {
  if (
    !/^\d+$/.test(timestamp) ||
    Math.abs(now / 1000 - Number(timestamp)) > 300 ||
    !/^[a-f0-9]{64}$/i.test(supplied)
  )
    return false;
  return timingSafeEqual(
    Buffer.from(signature(provider, timestamp, body), 'hex'),
    Buffer.from(supplied, 'hex'),
  );
}
// Free-text notes can contain copied identifiers; sanitize at every audit/response boundary.
export function sanitize<T>(value: T): T {
  // Match UUIDs first as whole tokens so an all-digit UUID segment is never mistaken for an account.
  const identifiers =
    /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b|\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[A-Z0-9]\b|\b[A-Z]{5}\d{4}[A-Z]\b|\b\d{9,18}\b/gi;
  const scrub = (v: any): any =>
    typeof v === 'string'
      ? v.replace(identifiers, (s) =>
          s.length === 36 && s.includes('-') ? s : '*'.repeat(s.length - 4) + s.slice(-4),
        )
      : Array.isArray(v)
        ? v.map(scrub)
        : v && typeof v === 'object' && !(v instanceof Date)
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)]))
          : v;
  return scrub(value);
}
