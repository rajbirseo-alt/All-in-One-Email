import { z } from 'zod';
import { PERMISSION_KEYS, SCOPES, type PermissionKey } from './permissions';

const id = z.string().min(1).max(64);
const email = z
  .string()
  .trim()
  .toLowerCase()
  .email()
  .max(254);
const name = z.string().trim().min(1).max(120);
const permissionKey = z.enum(PERMISSION_KEYS as [PermissionKey, ...PermissionKey[]]);
const scope = z.enum(SCOPES);

/** IANA zone check using the runtime's own tz database. */
export const timezone = z
  .string()
  .max(64)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'Unknown time zone');

/** 12+ chars; length matters more than composition rules (NIST 800-63B). */
export const password = z.string().min(12, 'Use at least 12 characters').max(256);

export const loginSchema = z.object({ email, password: z.string().min(1).max(256) });
export const mfaVerifySchema = z.object({
  mfaToken: z.string().min(1).max(2048),
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
});
export const mfaEnrollStartSchema = z.object({ mfaToken: z.string().min(1).max(2048) });
export const setPasswordSchema = z.object({ token: z.string().min(20).max(200), password });

export const createUserSchema = z.object({
  email,
  name,
  roleId: id,
  departmentId: id.nullable().optional(),
  managerId: id.nullable().optional(),
  timezone: timezone.optional(),
});
export const updateUserSchema = z
  .object({
    name: name.optional(),
    roleId: id.optional(),
    departmentId: id.nullable().optional(),
    managerId: id.nullable().optional(),
    timezone: timezone.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export const updateSelfSchema = z
  .object({ name: name.optional(), timezone: timezone.optional() })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export const absenceSchema = z
  .object({ isAbsent: z.boolean(), absentUntil: z.coerce.date().nullable().optional() })
  .refine((v) => !v.absentUntil || v.absentUntil > new Date(), {
    message: 'absentUntil must be in the future',
    path: ['absentUntil'],
  });
export const permissionOverridesSchema = z.object({
  overrides: z
    .array(
      z.object({
        permissionKey,
        effect: z.enum(['GRANT', 'DENY']),
        scope: scope.nullable().optional(),
        reason: z.string().max(500).optional(),
        expiresAt: z.coerce.date().nullable().optional(),
      }),
    )
    .max(PERMISSION_KEYS.length),
});
export const listUsersQuery = z.object({
  q: z.string().max(120).optional(),
  status: z.enum(['INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED']).optional(),
  departmentId: id.optional(),
  roleId: id.optional(),
  cursor: id.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const createRoleSchema = z.object({
  key: z
    .string()
    .trim()
    .regex(/^[A-Z][A-Z0-9_]{1,39}$/, 'Use UPPER_SNAKE_CASE'),
  name,
  description: z.string().max(500).optional(),
});
export const updateRoleSchema = z
  .object({ name: name.optional(), description: z.string().max(500).nullable().optional() })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export const rolePermissionsSchema = z.object({
  permissions: z
    .array(z.object({ permissionKey, scope }))
    .max(PERMISSION_KEYS.length)
    .refine((a) => new Set(a.map((p) => p.permissionKey)).size === a.length, 'Duplicate permission'),
});

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and dashes')
  .max(60);
export const createDepartmentSchema = z.object({ name, slug, managerId: id.nullable().optional() });
export const updateDepartmentSchema = z
  .object({ name: name.optional(), slug: slug.optional(), managerId: id.nullable().optional() })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export const createTeamSchema = z.object({ name, departmentId: id, leaderId: id.nullable().optional() });
export const updateTeamSchema = z
  .object({ name: name.optional(), leaderId: id.nullable().optional() })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export const teamMemberSchema = z.object({ userId: id, inRotation: z.boolean().default(true) });

export const auditQuery = z.object({
  entityType: z.string().max(60).optional(),
  entityId: id.optional(),
  actorId: id.optional(),
  action: z.string().max(80).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  cursor: id.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type PermissionOverridesInput = z.infer<typeof permissionOverridesSchema>;
export type RolePermissionsInput = z.infer<typeof rolePermissionsSchema>;
