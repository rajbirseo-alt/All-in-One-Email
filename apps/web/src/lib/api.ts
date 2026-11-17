/** Browser-side API client. Same-origin `/api/v1` (proxied to NestJS), cookies + CSRF header. */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: { path: string; message: string }[],
  ) {
    super(message);
  }

  /** Field → message, for showing validation errors next to inputs. */
  fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const d of this.details ?? []) if (d.path && !out[d.path]) out[d.path] = d.message;
    return out;
  }
}

function csrfToken(): string | undefined {
  const m = document.cookie.match(/(?:^|;\s*)(?:__Host-)?crm_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]!) : undefined;
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; query?: Record<string, string | number | undefined | null> } = {}): Promise<T> {
  const method = init.method ?? 'GET';
  const qs = init.query
    ? '?' +
      new URLSearchParams(
        Object.entries(init.query)
          .filter(([, v]) => v !== undefined && v !== null && v !== '')
          .map(([k, v]) => [k, String(v)]),
      ).toString()
    : '';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') {
    const t = csrfToken();
    if (t) headers['x-csrf-token'] = t;
  }
  const res = await fetch(`/api/v1${path}${qs === '?' ? '' : qs}`, {
    method,
    headers,
    credentials: 'same-origin',
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = data?.error;
    throw new ApiError(res.status, e?.code ?? 'ERROR', e?.message ?? `Request failed (${res.status})`, e?.details);
  }
  return data as T;
}
