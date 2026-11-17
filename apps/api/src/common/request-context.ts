import type { EffectivePermissions, PermissionKey, Scope } from '@crm/shared';
import type { Request } from 'express';

export interface RequestContext {
  userId: string;
  sessionId: string;
  roleKey: string;
  departmentId: string | null;
  permissions: EffectivePermissions;
  ip: string | null;
  userAgent: string | null;
}

export interface AuthedRequest extends Request {
  ctx?: RequestContext;
}

export function scopeOf(ctx: RequestContext, key: PermissionKey): Scope | undefined {
  return ctx.permissions[key];
}

/** Context for audit entries written outside an HTTP request (CLI, jobs). */
export interface AuditActor {
  userId: string | null;
  actorType?: 'USER' | 'SYSTEM' | 'AUTOMATION' | 'AI';
  ip?: string | null;
  userAgent?: string | null;
}
