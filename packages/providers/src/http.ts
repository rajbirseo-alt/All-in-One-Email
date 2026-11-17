import { AuthError, ProviderRequestError, RateLimitedError, TransientError } from './errors';
import type { AccessTokenSource } from './types';

export type FetchFn = typeof fetch;

export interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Statuses the caller handles itself; the response is returned instead of thrown. */
  allow?: number[];
}

export interface JsonResponse<T> {
  status: number;
  body: T;
}

const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'dailyLimitExceeded']);

/**
 * Authenticated JSON calls with provider error mapping. A 401 forces one token refresh and a
 * retry; a second 401 means the grant is no longer valid (AuthError).
 */
export class ProviderHttp {
  constructor(
    private readonly token: AccessTokenSource,
    private readonly fetchImpl: FetchFn = fetch,
  ) {}

  async json<T>(url: string, opts: RequestOptions = {}): Promise<JsonResponse<T>> {
    let res = await this.send(url, opts, false);
    if (res.status === 401) res = await this.send(url, opts, true);
    const text = await res.text();
    const body = text ? safeJson(text) : null;
    if (res.ok || opts.allow?.includes(res.status)) return { status: res.status, body: body as T };
    throw mapError(res.status, body, res.headers.get('retry-after'));
  }

  private async send(url: string, opts: RequestOptions, forceRefresh: boolean): Promise<Response> {
    const token = await this.token(forceRefresh);
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json', ...opts.headers };
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    try {
      return await this.fetchImpl(url, { method: opts.method ?? 'GET', headers, body });
    } catch (e) {
      throw new TransientError(`Network error: ${(e as Error).message}`);
    }
  }
}

export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

function errorInfo(body: unknown): { message: string; reason: string | null; code: string | null } {
  const err = (body as { error?: unknown } | null)?.error;
  if (err && typeof err === 'object') {
    const e = err as { message?: string; code?: string | number; errors?: { reason?: string }[]; status?: string };
    return { message: String(e.message ?? 'Provider error'), reason: e.errors?.[0]?.reason ?? e.status ?? null, code: e.code != null ? String(e.code) : null };
  }
  if (typeof err === 'string') {
    const d = (body as { error_description?: string }).error_description;
    return { message: d ?? err, reason: err, code: err };
  }
  return { message: 'Provider error', reason: null, code: null };
}

export function mapError(status: number, body: unknown, retryAfter: string | null) {
  const { message, reason, code } = errorInfo(body);
  const detail = `${status} ${reason ?? code ?? ''} ${message}`.replace(/\s+/g, ' ').trim();
  if (status === 401) return new AuthError(detail, status);
  if (status === 429 || (status === 403 && reason && RATE_LIMIT_REASONS.has(reason))) {
    const s = retryAfter ? Number(retryAfter) : NaN;
    return new RateLimitedError(detail, Number.isFinite(s) ? s : null, status);
  }
  // Missing scopes or a mailbox the grant no longer covers: only a reconnect fixes it.
  if (status === 403 && (reason === 'insufficientPermissions' || code === 'ErrorAccessDenied' || code === 'Authorization_RequestDenied')) {
    return new AuthError(detail, status);
  }
  if (status >= 500 || status === 408) return new TransientError(detail, status);
  return new ProviderRequestError(detail, status);
}
