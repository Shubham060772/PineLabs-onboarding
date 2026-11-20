import { config } from './config.js';
import type { CheckType, Form } from '../../../packages/shared/src/index.js';
export interface VerificationProvider {
  dispatch(
    type: CheckType,
    attemptId: string,
    appId: string,
    form: Form,
  ): Promise<{ provider_request_id: string }>;
}
export interface MerchantCoreClient {
  create(appId: string, legalName: string): Promise<{ merchant_id: string }>;
}
export class ProviderHttpError extends Error {
  constructor(public status: number) {
    super(`Provider returned HTTP ${status}`);
  }
  get retryable() {
    return this.status >= 500 || this.status === 408 || this.status === 429;
  }
}
async function post(url: string, body: unknown, key: string) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': key,
      'x-mock-secret': config.adminSecret,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new ProviderHttpError(response.status);
  return response.json();
}
export const providers: VerificationProvider = {
  async dispatch(type, attemptId, appId, form) {
    const subject =
      type === 'PAN'
        ? { pan: form.pan, legal_name: form.legal_name }
        : type === 'GST'
          ? { gstin: form.gstin, legal_name: form.legal_name }
          : type === 'BANK'
            ? form.bank_account
            : {
                pan: form.pan,
                gstin: form.gstin,
                bank_account: form.bank_account,
                business_category: form.business_category,
                pincode: form.pincode,
              };
    return post(
      `${config.mockUrl}/mock/${type.toLowerCase()}/${type === 'RISK' ? 'assess' : 'verify'}`,
      {
        application_id: appId,
        client_reference_id: attemptId,
        callback_url: `${config.apiUrl}/api/v1/webhooks/providers/${type.toLowerCase()}`,
        subject,
      },
      attemptId,
    );
  },
};
export const merchantCore: MerchantCoreClient = {
  create: (appId, legalName) =>
    post(
      `${config.mockUrl}/mock/merchant-core/merchants`,
      {
        application_id: appId,
        legal_name: legalName,
        capabilities: ['UPI', 'CARDS', 'NETBANKING'],
      },
      appId,
    ),
};
