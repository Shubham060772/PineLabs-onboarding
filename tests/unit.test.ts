import { describe, it, expect } from 'vitest';
import {
  APP_STATUSES,
  transitions,
  assertTransition,
  validPan,
  validGstin,
  validIfsc,
  validAccount,
  mask,
  nameSimilarity,
  reconcileField,
  mapResult,
  callbackSchema,
  ATTEMPT_STATUSES,
  attemptTransitions,
  assertAttemptTransition,
} from '../packages/shared/src/index.js';
import { demoForm, demoDocuments } from '../packages/shared/src/demo.js';
import {
  inputHash,
  encrypt,
  decrypt,
  signature,
  verifySignature,
  sanitize,
} from '../apps/api/src/crypto.js';
import { validate } from '../apps/api/src/validation.js';
import { parseExtraction } from '../apps/api/src/extraction.js';
describe('Deterministic rules', () => {
  it('does not treat different non-Latin names or punctuation-only names as identical', () => {
    expect(nameSimilarity('राम कुमार', 'सीता देवी')).toBe(0);
    expect(nameSimilarity('राम कुमार', 'राम कुमार')).toBe(1);
    expect(nameSimilarity('!!!', '???')).toBe(0);
    expect(nameSimilarity('Café Limited', 'Cafe\u0301 Limited')).toBe(1);
  });
  it.each(['OTHER', 'UNKNOWN', 'BANK_PROOF'] as const)(
    'accepts detected %s without treating matching identifiers as evidence for PAN',
    (detected) => {
      const extraction = parseExtraction(
        {
          detected_document_type: detected,
          legibility: 'CLEAR',
          fields: {
            pan_number: { value: demoForm().pan, confidence: 1 },
            name: { value: demoForm().legal_name, confidence: 1 },
          },
        },
        'PAN_CARD',
      );
      expect(extraction.fields.pan_number).toEqual({ value: null, confidence: 0 });
      const result = validate(demoForm(), [{ doc_type: 'PAN_CARD', extraction }]);
      expect(result.findings).toContainEqual(
        expect.objectContaining({
          rule_code: 'V-DOC-TYPE',
          passed: false,
          severity: 'BLOCKING',
          doc_type: 'PAN_CARD',
        }),
      );
      expect(
        result.findings.filter((f) => f.doc_type === 'PAN_CARD' && f.severity === 'REVIEW'),
      ).toEqual([]);
    },
  );
  it('attempt transition table rejects every transition out of a closed attempt', () => {
    for (const from of ATTEMPT_STATUSES)
      for (const to of ATTEMPT_STATUSES) {
        if (attemptTransitions[from].includes(to))
          expect(() => assertAttemptTransition(from, to)).not.toThrow();
        else expect(() => assertAttemptTransition(from, to)).toThrow();
      }
  });
  it('T-U1 PAN accepts normalized values and rejects malformed identifiers', () => {
    expect(validPan('abcck0001f')).toBe(true);
    expect(validPan('ABC123')).toBe(false);
  });
  it('T-U2 GSTIN checksum rejects an altered character', () => {
    const gst = demoForm().gstin!;
    expect(validGstin(gst)).toBe(true);
    expect(validGstin(gst.slice(0, -1) + (gst.endsWith('0') ? '1' : '0'))).toBe(false);
  });
  it('T-U3 conflicting PAN inside GST is blocking', () => {
    const f = demoForm();
    f.gstin = demoForm(2).gstin;
    expect(validate(f, []).findings.find((x) => x.rule_code === 'V-XREF-GSTIN-PAN')).toMatchObject({
      passed: false,
      severity: 'BLOCKING',
    });
  });
  it('T-U4 IFSC and account boundaries', () => {
    expect(validIfsc('HDFC0001234')).toBe(true);
    expect(validIfsc('HDFC1001234')).toBe(false);
    expect(validAccount('123456789')).toBe(true);
    expect(validAccount('123')).toBe(false);
  });
  it('T-U5 name normalization', () => {
    expect(nameSimilarity('Kaveri Textiles Pvt Ltd', 'KAVERI TEXTILES PRIVATE LIMITED')).toBe(1);
    expect(nameSimilarity('Kaveri Textiles', 'Unrelated Shop')).toBeLessThan(0.85);
  });
  it('T-U6 checks every pair in the ten-state transition table', () => {
    for (const from of APP_STATUSES)
      for (const to of APP_STATUSES) {
        if (transitions[from].includes(to)) expect(() => assertTransition(from, to)).not.toThrow();
        else expect(() => assertTransition(from, to)).toThrow();
      }
  });
  it('T-U7 exposes only last four characters', () => {
    for (const id of [
      demoForm().pan!,
      demoForm().gstin!,
      demoForm().bank_account!.account_number,
    ]) {
      expect(mask(id)).toMatch(/^\*+.{4}$/);
      expect(mask(id)).not.toContain(id);
    }
  });
  it('T-U8 holder changes invalidate BANK and RISK only', () => {
    const a = demoForm(),
      b = demoForm();
    b.bank_account!.account_holder_name = 'Changed Holder';
    for (const t of ['PAN', 'GST'] as const) expect(inputHash(t, a)).toBe(inputHash(t, b));
    for (const t of ['BANK', 'RISK'] as const) expect(inputHash(t, a)).not.toBe(inputHash(t, b));
  });
  it('T-U9 risk score controls decisions', () => {
    for (const [band, score, status, review] of [
      ['LOW', 10, 'PASSED', false],
      ['MEDIUM', 45, 'PASSED', true],
      ['HIGH', 90, 'FAILED', false],
    ] as const) {
      const p = callbackSchema.parse({
        event_id: 'a',
        client_reference_id: '11111111-1111-4111-8111-111111111111',
        provider_request_id: 'r',
        status: 'ASSESSED',
        details: { band, score },
        occurred_at: new Date().toISOString(),
      });
      expect(mapResult('RISK', p)).toEqual({ status, review });
    }
  });
  it('T-U10 field reconciliation', () => {
    expect(reconcileField('A', 'A', 0.95, true, true)).toBe('MATCH');
    expect(reconcileField('B', 'A', 0.95, true, true)).toBe('CONFLICT');
    expect(reconcileField('B', 'A', 0.6, true, true)).toBe('LOW_CONFIDENCE');
    expect(reconcileField(null, 'A', 0, false, false)).toBe('UNREADABLE');
  });
  it('encrypts with unique nonces and detects tampering', () => {
    const a = encrypt(demoForm()),
      b = encrypt(demoForm());
    expect(a).not.toBe(b);
    expect(decrypt(a)).toEqual(demoForm());
    const data = Buffer.from(a, 'base64');
    data[30] ^= 1;
    expect(() => decrypt(data.toString('base64'))).toThrow();
  });
  it('T-AI1 rejects malformed extraction output', () => {
    expect(() =>
      parseExtraction({ fields: { pan_number: { value: 'x', confidence: 2 } } }, 'PAN_CARD'),
    ).toThrow();
  });
  it('PII scrubbing preserves numeric UUID segments while masking identifiers in free text', () => {
    const id = '0d1b9603-465e-4a9d-88f6-123456785591';
    expect(sanitize({ id, note: `App ${id}; account 123456789012 and PAN ABCCK0001F` })).toEqual({
      id,
      note: `App ${id}; account ********9012 and PAN ******001F`,
    });
  });
});
