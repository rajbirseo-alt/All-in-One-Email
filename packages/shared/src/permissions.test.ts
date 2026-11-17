import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROLE_MATRIX,
  PERMISSION_KEYS,
  SYSTEM_ROLES,
  hasScopeAtLeast,
  resolvePermissions,
} from './permissions';

describe('resolvePermissions', () => {
  const role = [
    { key: 'conversation.read', scope: 'ASSIGNED' as const },
    { key: 'report.read', scope: 'OWN' as const },
  ];

  it('returns role scopes when there are no overrides', () => {
    expect(resolvePermissions({ rolePermissions: role, overrides: [] })).toEqual({
      'conversation.read': 'ASSIGNED',
      'report.read': 'OWN',
    });
  });

  it('DENY override removes a role permission', () => {
    const eff = resolvePermissions({
      rolePermissions: role,
      overrides: [{ key: 'report.read', effect: 'DENY', scope: null, expiresAt: null }],
    });
    expect(eff['report.read']).toBeUndefined();
  });

  it('GRANT override widens scope and adds new permissions', () => {
    const eff = resolvePermissions({
      rolePermissions: role,
      overrides: [
        { key: 'conversation.read', effect: 'GRANT', scope: 'DEPARTMENT', expiresAt: null },
        { key: 'audit.read', effect: 'GRANT', scope: null, expiresAt: null },
      ],
    });
    expect(eff['conversation.read']).toBe('DEPARTMENT');
    expect(eff['audit.read']).toBe('ALL'); // global permission defaults to ALL
  });

  it('ignores expired overrides and unknown keys', () => {
    const now = new Date('2026-11-16T12:00:00Z');
    const eff = resolvePermissions(
      {
        rolePermissions: [...role, { key: 'not.a.permission', scope: 'ALL' }],
        overrides: [
          { key: 'report.read', effect: 'DENY', scope: null, expiresAt: new Date('2026-11-01T00:00:00Z') },
        ],
      },
      now,
    );
    expect(eff['report.read']).toBe('OWN');
    expect(Object.keys(eff)).not.toContain('not.a.permission');
  });
});

describe('default role matrix', () => {
  it('defines every system role and only known permissions', () => {
    expect(Object.keys(DEFAULT_ROLE_MATRIX).sort()).toEqual(Object.keys(SYSTEM_ROLES).sort());
    for (const matrix of Object.values(DEFAULT_ROLE_MATRIX)) {
      for (const key of Object.keys(matrix)) expect(PERMISSION_KEYS).toContain(key);
    }
  });

  it('Super Admin has every permission at ALL', () => {
    for (const k of PERMISSION_KEYS) expect(DEFAULT_ROLE_MATRIX.SUPER_ADMIN[k]).toBe('ALL');
  });

  it('employees cannot manage users, roles, mailboxes or read audit', () => {
    for (const r of ['EMPLOYEE', 'SALES', 'HR', 'FINANCE'] as const) {
      for (const k of ['user.manage', 'role.manage', 'account.manage', 'account.connect', 'audit.read'] as const) {
        expect(DEFAULT_ROLE_MATRIX[r][k]).toBeUndefined();
      }
      expect(DEFAULT_ROLE_MATRIX[r]['conversation.read']).toBe('ASSIGNED');
    }
  });
});

describe('hasScopeAtLeast', () => {
  it('orders scopes narrow → wide', () => {
    expect(hasScopeAtLeast('DEPARTMENT', 'TEAM')).toBe(true);
    expect(hasScopeAtLeast('TEAM', 'DEPARTMENT')).toBe(false);
    expect(hasScopeAtLeast(undefined, 'OWN')).toBe(false);
  });
});
