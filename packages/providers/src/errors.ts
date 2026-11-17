/**
 * Error classes drive retry behaviour (docs/06 §1):
 *  - AuthError: the account needs to be reconnected; do not retry.
 *  - RateLimitedError: retry later.
 *  - TransientError: retry with backoff.
 *  - CursorExpiredError: the sync cursor is no longer valid; resync the window.
 *  - ProviderRequestError: any other rejected request (a bug or unsupported case); do not retry blindly.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class AuthError extends ProviderError {}
export class TransientError extends ProviderError {}
export class CursorExpiredError extends ProviderError {}
export class ProviderRequestError extends ProviderError {}
export class RateLimitedError extends ProviderError {
  constructor(
    message: string,
    readonly retryAfterSeconds: number | null,
    status?: number,
  ) {
    super(message, status);
  }
}
