import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { PermissionKey } from '@crm/shared';
import type { AuthedRequest, RequestContext } from './request-context';

export const ACCESS_KEY = 'crm:access';

/**
 * Every route must declare its access rule — the global guard rejects routes that do not
 * (fail closed), so a forgotten decorator can never expose data.
 */
export type AccessRule =
  | { kind: 'public' }
  | { kind: 'authenticated' }
  | { kind: 'permission'; anyOf: PermissionKey[] };

/** No session required (login, OAuth callbacks, health, provider webhooks). */
export const Public = () => SetMetadata(ACCESS_KEY, { kind: 'public' } satisfies AccessRule);
/** Any signed-in employee (own profile, own sessions). */
export const Authenticated = () => SetMetadata(ACCESS_KEY, { kind: 'authenticated' } satisfies AccessRule);
/** Signed in and holding at least one of the permissions (at any scope; services apply the scope). */
export const RequirePermission = (...anyOf: PermissionKey[]) =>
  SetMetadata(ACCESS_KEY, { kind: 'permission', anyOf } satisfies AccessRule);

export const Ctx = createParamDecorator((_: unknown, ctx: ExecutionContext): RequestContext => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  return req.ctx!;
});
