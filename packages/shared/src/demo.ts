import { gstCheck, type Form, type DocType } from './index.js';
export function uniqueDemoForm(name = 'Kaveri Textiles Private Limited'): Form {
  const nonce = globalThis.crypto.randomUUID().replaceAll('-', '');
  const f = demoForm(1, name);
  f.pan =
    [...nonce.slice(0, 3)].map((c) => String.fromCharCode(65 + parseInt(c, 16))).join('') +
    'CK' +
    String(parseInt(nonce.slice(3, 7), 16) % 10000).padStart(4, '0') +
    'F';
  const prefix = `33${f.pan}1Z`;
  f.gstin = prefix + gstCheck(prefix);
  f.contact_email = `owner-${nonce.slice(0, 8)}@synthetic.example`;
  f.bank_account!.account_number = BigInt('0x' + nonce.slice(0, 14))
    .toString()
    .padStart(18, '0');
  return f;
}
export function demoForm(n = 1, name = 'Kaveri Textiles Private Limited'): Form {
  const pan = `ABCCK${String(n).padStart(4, '0')}F`,
    prefix = `33${pan}1Z`;
  return {
    legal_name: name,
    trade_name: name.replace(' Private Limited', ''),
    business_type: 'PRIVATE_LIMITED',
    business_category: 'TEXTILES_RETAIL',
    contact_email: `owner${n}@synthetic.example`,
    contact_phone: '+919800000001',
    address_line: '12 Mill Road',
    city: 'Coimbatore',
    state: 'TN',
    pincode: '641001',
    pan,
    gstin: prefix + gstCheck(prefix),
    bank_account: {
      account_number: `12345678${String(n).padStart(4, '0')}`,
      ifsc: 'HDFC0001234',
      account_holder_name: name,
    },
  };
}
export function demoDocuments(f: Form): Record<DocType, Record<string, string>> {
  return {
    PAN_CARD: { pan_number: f.pan ?? '', name: f.legal_name },
    GST_CERTIFICATE: {
      gstin: f.gstin ?? '',
      legal_name: f.legal_name,
      trade_name: f.trade_name ?? f.legal_name,
    },
    BANK_PROOF: {
      account_number: f.bank_account?.account_number ?? '',
      ifsc: f.bank_account?.ifsc ?? '',
      account_holder_name: f.bank_account?.account_holder_name ?? '',
      bank_name: 'Synthetic Demo Bank',
    },
  };
}
