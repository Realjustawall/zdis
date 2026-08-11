export class ApiError extends Error {
  status: number;
  code: string;
  details?: { path: string; message: string }[] | string[];

  constructor(status: number, code: string, message: string, details?: ApiError['details']) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** Flattens zod-style details into lines a form can render. */
  get lines(): string[] {
    if (!this.details) return [this.message];
    return this.details.map((detail) =>
      typeof detail === 'string' ? detail : `${detail.path}: ${detail.message}`,
    );
  }
}

function csrfToken(): string | null {
  const match = document.cookie.match(/(?:^|;\s*)ytbl_csrf=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : null;
}

type Options = { signal?: AbortSignal };

const RETRYABLE_STATUS = new Set([502, 503, 504]);

function retryableRequest(method: string, path: string) {
  return method === 'GET' ||
    method === 'HEAD' ||
    path === '/api/auth/login' ||
    path === '/api/auth/register';
}

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

async function request<T>(method: string, path: string, body?: unknown, options: Options = {}): Promise<T> {
  const headers: Record<string, string> = {};
  let payload: BodyInit | undefined;

  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  if (method !== 'GET' && method !== 'HEAD') {
    const token = csrfToken();
    if (token) headers['X-CSRF-Token'] = token;
  }

  let response: Response | null = null;
  const delays = retryableRequest(method, path) ? [0, 450, 1100, 2200] : [0];
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt]) await wait(delays[attempt]);
    try {
      response = await fetch(path, {
        method,
        headers,
        body: payload,
        credentials: 'same-origin',
        signal: options.signal,
        cache: method === 'GET' ? 'no-store' : undefined,
      });
      if (!RETRYABLE_STATUS.has(response.status) || attempt === delays.length - 1) break;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (attempt === delays.length - 1) {
        throw new ApiError(
          0,
          'network_error',
          document.documentElement.lang === 'fa'
            ? 'ارتباط با سرور برقرار نشد. اتصال خود را بررسی کنید و دوباره تلاش کنید.'
            : 'Could not reach the server. Check your connection and try again.',
        );
      }
    }
  }
  if (!response) {
    throw new ApiError(
      0,
      'network_error',
      document.documentElement.lang === 'fa'
        ? 'ارتباط با سرور برقرار نشد. دوباره تلاش کنید.'
        : 'Could not reach the server. Try again.',
    );
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!response.ok) {
    const error = (parsed as { error?: { code: string; message: string; details?: never } })?.error;
    throw new ApiError(
      response.status,
      error?.code ?? 'error',
      error?.message ??
        (RETRYABLE_STATUS.has(response.status)
          ? document.documentElement.lang === 'fa'
            ? 'سرور در حال راه‌اندازی مجدد است؛ چند لحظه دیگر دوباره تلاش کنید.'
            : 'The service is restarting. Please try again shortly.'
          : `Request failed (${response.status})`),
      error?.details,
    );
  }

  return parsed as T;
}

async function requestBlob(path: string, body: unknown, options: Options = {}): Promise<Blob> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = csrfToken();
  if (token) headers['X-CSRF-Token'] = token;
  const response = await fetch(path, {
    method: 'POST', headers, body: JSON.stringify(body), credentials: 'same-origin',
    signal: options.signal, cache: 'no-store',
  });
  if (response.ok) return response.blob();
  const text = await response.text();
  let parsed: { error?: { code?: string; message?: string; details?: ApiError['details'] } } = {};
  try { parsed = JSON.parse(text); } catch { /* upstream may return plain text */ }
  throw new ApiError(
    response.status,
    parsed.error?.code ?? 'error',
    parsed.error?.message ?? `Request failed (${response.status})`,
    parsed.error?.details,
  );
}

async function requestBinary<T>(path: string, body: Blob, options: Options = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' };
  const token = csrfToken();
  if (token) headers['X-CSRF-Token'] = token;
  const response = await fetch(path, {
    method: 'PUT', headers, body, credentials: 'same-origin', signal: options.signal, cache: 'no-store',
  });
  const text = await response.text();
  let parsed: unknown = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!response.ok) {
    const error = (parsed as { error?: { code?: string; message?: string; details?: ApiError['details'] } })?.error;
    throw new ApiError(response.status, error?.code ?? 'error', error?.message ?? `Request failed (${response.status})`, error?.details);
  }
  return parsed as T;
}

export const api = {
  get: <T,>(path: string, options?: Options) => request<T>('GET', path, undefined, options),
  post: <T,>(path: string, body?: unknown, options?: Options) => request<T>('POST', path, body, options),
  patch: <T,>(path: string, body?: unknown, options?: Options) => request<T>('PATCH', path, body, options),
  put: <T,>(path: string, body?: unknown, options?: Options) => request<T>('PUT', path, body, options),
  del: <T,>(path: string, body?: unknown, options?: Options) => request<T>('DELETE', path, body, options),
  postBlob: (path: string, body: unknown, options?: Options) => requestBlob(path, body, options),
  putBinary: <T,>(path: string, body: Blob, options?: Options) => requestBinary<T>(path, body, options),
};
