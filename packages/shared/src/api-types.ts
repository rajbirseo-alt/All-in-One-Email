import type { EffectivePermissions } from './permissions';

/** Response shapes shared by the API and the web app. */

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface MeResponse {
  user: {
    id: string;
    email: string;
    name: string;
    avatarUrl: string | null;
    timezone: string;
    isAbsent: boolean;
    absentUntil: string | null;
    mfaEnabled: boolean;
    role: { id: string; key: string; name: string };
    department: { id: string; name: string } | null;
  };
  permissions: EffectivePermissions;
  session: { id: string; authMethod: string; expiresAt: string };
}

export interface AuthProvidersResponse {
  google: boolean;
  microsoft: boolean;
  password: boolean;
}

export type LoginResponse =
  | { status: 'ok' }
  | { status: 'mfa_required'; mfaToken: string }
  | { status: 'mfa_enrollment_required'; mfaToken: string };

export interface UserSummary {
  id: string;
  email: string;
  name: string;
  status: 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
  timezone: string;
  isAbsent: boolean;
  lastLoginAt: string | null;
  mfaEnabled: boolean;
  hasPassword: boolean;
  role: { id: string; key: string; name: string };
  department: { id: string; name: string } | null;
  manager: { id: string; name: string } | null;
  createdAt: string;
}

export interface RoleDetail {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  userCount: number;
  permissions: { permissionKey: string; scope: string }[];
}

export interface DepartmentDetail {
  id: string;
  name: string;
  slug: string;
  manager: { id: string; name: string } | null;
  memberCount: number;
  teams: TeamDetail[];
}

export interface TeamDetail {
  id: string;
  name: string;
  departmentId: string;
  leader: { id: string; name: string } | null;
  members: { userId: string; name: string; email: string; inRotation: boolean }[];
}

export interface AuditEntry {
  id: string;
  actor: { id: string; name: string } | null;
  actorType: string;
  action: string;
  entityType: string;
  entityId: string | null;
  ip: string | null;
  before: unknown;
  after: unknown;
  metadata: unknown;
  createdAt: string;
}

export interface SessionInfo {
  id: string;
  ip: string | null;
  userAgent: string | null;
  authMethod: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  current: boolean;
}
