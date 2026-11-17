import { hasScopeAtLeast, type PermissionKey, type Scope } from '@crm/shared';
import { Errors } from '../common/errors';
import type { RequestContext } from '../common/request-context';

/**
 * Anti-escalation: nobody may hand out access wider than their own.
 * Applies to assigning roles, editing a role's matrix and per-user GRANT overrides.
 */
export function assertCanGrant(ctx: RequestContext, grants: { key: PermissionKey; scope: Scope }[]) {
  const over = grants.filter((g) => !hasScopeAtLeast(ctx.permissions[g.key], g.scope));
  if (over.length) {
    throw Errors.forbidden(
      `You cannot grant access you do not have yourself: ${over.map((g) => `${g.key} (${g.scope})`).join(', ')}`,
    );
  }
}
