import { HttpException, HttpStatus } from '@nestjs/common';

/** All API errors use the shape `{ error: { code, message, details? } }` (docs/03-api.md). */
export class ApiException extends HttpException {
  constructor(status: number, code: string, message: string, details?: unknown) {
    super({ error: { code, message, ...(details !== undefined ? { details } : {}) } }, status);
  }
}

export const Errors = {
  unauthenticated: (msg = 'Sign in to continue') => new ApiException(HttpStatus.UNAUTHORIZED, 'UNAUTHENTICATED', msg),
  forbidden: (msg = 'You do not have permission to do this') => new ApiException(HttpStatus.FORBIDDEN, 'FORBIDDEN', msg),
  /** Also used for records that exist but are outside the caller's scope, so existence never leaks. */
  notFound: (what = 'Record') => new ApiException(HttpStatus.NOT_FOUND, 'NOT_FOUND', `${what} not found`),
  conflict: (msg: string, code = 'CONFLICT') => new ApiException(HttpStatus.CONFLICT, code, msg),
  validation: (details: unknown, msg = 'Some fields are invalid') =>
    new ApiException(HttpStatus.UNPROCESSABLE_ENTITY, 'VALIDATION_FAILED', msg, details),
  badRequest: (msg: string, code = 'BAD_REQUEST') => new ApiException(HttpStatus.BAD_REQUEST, code, msg),
  csrf: () => new ApiException(HttpStatus.FORBIDDEN, 'CSRF_FAILED', 'Security check failed — reload the page and try again'),
};
