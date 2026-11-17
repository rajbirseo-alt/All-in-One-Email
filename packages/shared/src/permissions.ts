/**
 * Permission catalogue and default role matrix (docs/05-auth-permissions.md §4).
 * This is the single source of truth: the seed writes it to the database, the API
 * guards reference these keys, and the admin UI renders them.
 */

export const SCOPES = ['OWN', 'ASSIGNED', 'TEAM', 'DEPARTMENT', 'ALL'] as const;
export type Scope = (typeof SCOPES)[number];

/** Higher number = wider access. */
export const SCOPE_RANK: Record<Scope, number> = {
  OWN: 1,
  ASSIGNED: 2,
  TEAM: 3,
  DEPARTMENT: 4,
  ALL: 5,
};

export const PERMISSIONS = {
  'conversation.read': 'View conversations, messages and attachments',
  'conversation.reply': 'Send email from a mailbox (also requires mailbox REPLY access)',
  'conversation.assign': 'Assign, reassign and bulk-assign conversations',
  'conversation.status': 'Change conversation status',
  'conversation.share': 'Share a conversation with a colleague',
  'conversation.raw': 'View raw email headers',
  'note.write': 'Write internal notes',
  'account.connect': 'Connect new mailboxes',
  'account.manage': 'Manage mailbox settings, access and disconnection',
  'user.read': 'View the employee directory',
  'user.manage': 'Invite, edit and suspend employees',
  'role.manage': 'Manage roles, permissions and overrides',
  'org.manage': 'Manage departments and teams',
  'rules.manage': 'Manage assignment rules',
  'sla.manage': 'Manage SLA policies and business calendars',
  'automation.manage': 'Manage automation rules',
  'contact.read': 'View CRM contacts and companies',
  'contact.write': 'Create and edit CRM contacts and companies',
  'contact.merge': 'Merge duplicate contacts',
  'lead.read': 'View sales leads',
  'lead.write': 'Create and edit sales leads',
  'task.read': 'View tasks',
  'task.write': 'Create and edit tasks',
  'report.read': 'View dashboards and reports',
  'report.export': 'Export reports to CSV',
  'audit.read': 'View the audit log',
  'ai.use': 'Use AI assistant features',
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;
export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as PermissionKey[];

/**
 * Permissions whose scope is meaningless — the holder either can or cannot.
 * They are stored with scope ALL.
 */
export const GLOBAL_PERMISSIONS: ReadonlySet<PermissionKey> = new Set([
  'account.connect',
  'account.manage',
  'user.manage',
  'role.manage',
  'org.manage',
  'audit.read',
  'report.export',
  'contact.merge',
  'conversation.raw',
]);

export const SYSTEM_ROLES = {
  SUPER_ADMIN: { name: 'Super Admin / CMO', description: 'Complete system access' },
  MD: { name: 'MD', description: 'Company-wide visibility and management reports' },
  DEPT_MANAGER: { name: 'Department Manager', description: 'Manages an authorised department' },
  TEAM_LEADER: { name: 'Team Leader', description: 'Leads a team within a department' },
  EMPLOYEE: { name: 'Employee', description: 'Own and assigned conversations' },
  SALES: { name: 'Sales Member', description: 'Sales enquiries and own leads' },
  HR: { name: 'HR', description: 'HR mailbox and employee directory' },
  FINANCE: { name: 'Finance', description: 'Finance mailbox and department contacts' },
} as const;

export type SystemRoleKey = keyof typeof SYSTEM_ROLES;

type Matrix = Partial<Record<PermissionKey, Scope>>;

const everything: Matrix = Object.fromEntries(PERMISSION_KEYS.map((k) => [k, 'ALL'])) as Matrix;

const individualContributor = (extra: Matrix): Matrix => ({
  'conversation.read': 'ASSIGNED',
  'conversation.reply': 'ASSIGNED',
  'conversation.status': 'ASSIGNED',
  'note.write': 'ASSIGNED',
  'user.read': 'TEAM',
  'contact.read': 'OWN',
  'contact.write': 'OWN',
  'task.read': 'OWN',
  'task.write': 'OWN',
  'report.read': 'OWN',
  'ai.use': 'ASSIGNED',
  ...extra,
});

/** Default scope per (role, permission). Absent = not granted. Editable in the admin UI. */
export const DEFAULT_ROLE_MATRIX: Record<SystemRoleKey, Matrix> = {
  SUPER_ADMIN: everything,
  MD: {
    'conversation.read': 'ALL',
    'conversation.reply': 'ALL',
    'conversation.assign': 'ALL',
    'conversation.status': 'ALL',
    'conversation.share': 'ALL',
    'note.write': 'ALL',
    'user.read': 'ALL',
    'contact.read': 'ALL',
    'contact.write': 'ALL',
    'lead.read': 'ALL',
    'lead.write': 'ALL',
    'task.read': 'ALL',
    'task.write': 'ALL',
    'report.read': 'ALL',
    'report.export': 'ALL',
    'audit.read': 'ALL',
    'ai.use': 'ALL',
  },
  DEPT_MANAGER: {
    'conversation.read': 'DEPARTMENT',
    'conversation.reply': 'DEPARTMENT',
    'conversation.assign': 'DEPARTMENT',
    'conversation.status': 'DEPARTMENT',
    'conversation.share': 'DEPARTMENT',
    'note.write': 'DEPARTMENT',
    'user.read': 'DEPARTMENT',
    'rules.manage': 'DEPARTMENT',
    'sla.manage': 'DEPARTMENT',
    'automation.manage': 'DEPARTMENT',
    'contact.read': 'DEPARTMENT',
    'contact.write': 'DEPARTMENT',
    'lead.read': 'DEPARTMENT',
    'lead.write': 'DEPARTMENT',
    'task.read': 'DEPARTMENT',
    'task.write': 'DEPARTMENT',
    'report.read': 'DEPARTMENT',
    'ai.use': 'DEPARTMENT',
  },
  TEAM_LEADER: {
    'conversation.read': 'TEAM',
    'conversation.reply': 'TEAM',
    'conversation.assign': 'TEAM',
    'conversation.status': 'TEAM',
    'conversation.share': 'TEAM',
    'note.write': 'TEAM',
    'user.read': 'TEAM',
    'contact.read': 'TEAM',
    'contact.write': 'TEAM',
    'lead.read': 'TEAM',
    'lead.write': 'TEAM',
    'task.read': 'TEAM',
    'task.write': 'TEAM',
    'report.read': 'TEAM',
    'ai.use': 'TEAM',
  },
  EMPLOYEE: individualContributor({}),
  SALES: individualContributor({
    'contact.read': 'DEPARTMENT',
    'contact.write': 'DEPARTMENT',
    'lead.read': 'OWN',
    'lead.write': 'OWN',
  }),
  HR: individualContributor({ 'user.read': 'ALL' }),
  FINANCE: individualContributor({
    'contact.read': 'DEPARTMENT',
    'contact.write': 'DEPARTMENT',
  }),
};

/** Roles whose members must use MFA when signing in with a password. */
export const MFA_REQUIRED_ROLES: ReadonlySet<string> = new Set(['SUPER_ADMIN', 'MD']);
/** Holding any of these also makes MFA mandatory for password sign-in. */
export const MFA_REQUIRED_PERMISSIONS: ReadonlySet<PermissionKey> = new Set([
  'account.manage',
  'role.manage',
  'user.manage',
]);

export type EffectivePermissions = Partial<Record<PermissionKey, Scope>>;

export interface PermissionSource {
  rolePermissions: { key: string; scope: Scope }[];
  overrides: { key: string; effect: 'GRANT' | 'DENY'; scope: Scope | null; expiresAt: Date | null }[];
}

/**
 * effective(user, p) = DENY override → none
 *                    | GRANT override(scope) → that scope (defaults to the role's scope, else ASSIGNED)
 *                    | role scope → scope
 */
export function resolvePermissions(src: PermissionSource, now: Date = new Date()): EffectivePermissions {
  const out: EffectivePermissions = {};
  for (const rp of src.rolePermissions) {
    if (isPermissionKey(rp.key)) out[rp.key] = rp.scope;
  }
  for (const o of src.overrides) {
    if (!isPermissionKey(o.key)) continue;
    if (o.expiresAt && o.expiresAt <= now) continue;
    if (o.effect === 'DENY') {
      delete out[o.key];
    } else {
      out[o.key] = o.scope ?? out[o.key] ?? (GLOBAL_PERMISSIONS.has(o.key) ? 'ALL' : 'ASSIGNED');
    }
  }
  return out;
}

export function isPermissionKey(k: string): k is PermissionKey {
  return Object.prototype.hasOwnProperty.call(PERMISSIONS, k);
}

export function hasScopeAtLeast(granted: Scope | undefined, needed: Scope): boolean {
  return granted !== undefined && SCOPE_RANK[granted] >= SCOPE_RANK[needed];
}
