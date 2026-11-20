import type { User } from '../../../packages/shared/src/index.js';
export const session = () => {
  try {
    return JSON.parse(sessionStorage.getItem('onboard.session') ?? 'null') as {
      token: string;
      user: User;
    } | null;
  } catch {
    return null;
  }
};
export class ApiError extends Error {
  constructor(
    message: string,
    public code: string,
    public details: any,
  ) {
    super(message);
  }
}
export async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData))
    headers.set('content-type', 'application/json');
  const auth = session();
  if (auth) headers.set('authorization', `Bearer ${auth.token}`);
  const response = await fetch(`/api/v1${path}`, { ...init, headers });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== '/auth/login') {
      sessionStorage.removeItem('onboard.session');
      window.location.assign('/login');
    }
    throw new ApiError(
      data.error?.message ?? 'Request failed',
      data.error?.code ?? 'ERROR',
      data.error?.details,
    );
  }
  return data;
}
export async function viewDocument(appId: string, docId: string) {
  const res = await fetch(`/api/v1/applications/${appId}/documents/${docId}/content`, {
    headers: { authorization: `Bearer ${session()?.token}` },
  });
  if (!res.ok) throw new Error('Unable to open document');
  const url = URL.createObjectURL(await res.blob());
  window.open(url, '_blank', 'noopener,noreferrer');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
