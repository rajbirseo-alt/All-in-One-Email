import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@crm/crypto';
import { SYSTEM_ROLES, type SystemRoleKey } from '@crm/shared';
import { Client, bootApp, clientAs, makeDepartment, makeUser, prisma, roleId, uniqueEmail } from './helpers';

let app: INestApplication;
beforeAll(async () => {
  ({ app } = await bootApp());
});
afterAll(() => app.close());

const ROLES = Object.keys(SYSTEM_ROLES) as SystemRoleKey[];

describe('endpoint × role matrix (default permissions)', () => {
  // [method, path, roles allowed]. Anything not allowed must be 403.
  const cases: [string, string, SystemRoleKey[]][] = [
    ['get', '/users', ROLES], // all roles hold user.read (scope differs)
    ['get', '/departments', ROLES],
    ['get', '/roles', ['SUPER_ADMIN']],
    ['get', '/permissions', ['SUPER_ADMIN']],
    ['get', '/audit-logs', ['SUPER_ADMIN', 'MD']],
    ['post', '/users', ['SUPER_ADMIN']],
    ['post', '/departments', ['SUPER_ADMIN']],
    ['post', '/roles', ['SUPER_ADMIN']],
  ];

  for (const role of ROLES) {
    it(`${role}`, async () => {
      const u = await makeUser({ role });
      const c = await clientAs(app, u.id);
      for (const [method, path, allowed] of cases) {
        const body = method === 'post' ? {} : undefined; // empty body → 422 when allowed, 403 when not
        const r = await c.send(method as 'get' | 'post', path, body);
        if (allowed.includes(role)) {
          expect([200, 422], `${role} ${method} ${path}`).toContain(r.status);
        } else {
          expect(r.status, `${role} ${method} ${path}`).toBe(403);
        }
      }
    });
  }

  it('rejects unauthenticated requests with 401', async () => {
    for (const p of ['/users', '/roles', '/audit-logs', '/auth/me', '/departments']) {
      expect((await new Client(app).get(p)).status).toBe(401);
    }
  });
});

describe('scoped visibility of the employee directory', () => {
  it('employee sees only self and team-mates; manager sees department; HR sees everyone', async () => {
    const sales = await makeDepartment();
    const finance = await makeDepartment();
    const manager = await makeUser({ role: 'DEPT_MANAGER', departmentId: sales.id });
    await prisma.department.update({ where: { id: sales.id }, data: { managerId: manager.id } });
    const emp = await makeUser({ role: 'EMPLOYEE', departmentId: sales.id });
    const mate = await makeUser({ role: 'EMPLOYEE', departmentId: sales.id });
    const salesStranger = await makeUser({ role: 'EMPLOYEE', departmentId: sales.id });
    const financeUser = await makeUser({ role: 'FINANCE', departmentId: finance.id });
    const hr = await makeUser({ role: 'HR', departmentId: finance.id });
    const team = await prisma.team.create({ data: { id: newId(), name: 'Inbound', departmentId: sales.id } });
    await prisma.teamMember.createMany({ data: [{ teamId: team.id, userId: emp.id }, { teamId: team.id, userId: mate.id }] });

    const ids = async (userId: string) => {
      const r = await (await clientAs(app, userId)).get('/users?limit=100');
      expect(r.status).toBe(200);
      return new Set<string>(r.body.items.map((u: { id: string }) => u.id));
    };

    const empSees = await ids(emp.id);
    expect(empSees).toEqual(new Set([emp.id, mate.id]));

    const mgrSees = await ids(manager.id);
    for (const id of [manager.id, emp.id, mate.id, salesStranger.id]) expect(mgrSees.has(id)).toBe(true);
    expect(mgrSees.has(financeUser.id)).toBe(false);

    const hrSees = await ids(hr.id);
    for (const id of [emp.id, financeUser.id, manager.id]) expect(hrSees.has(id)).toBe(true);

    // Out-of-scope single fetch is a 404, not a 403 — existence is not revealed.
    const empClient = await clientAs(app, emp.id);
    expect((await empClient.get(`/users/${financeUser.id}`)).status).toBe(404);
    expect((await empClient.get(`/users/${mate.id}`)).status).toBe(200);
  });
});

describe('privilege escalation guards', () => {
  it('a user manager without role.manage cannot hand out Super Admin', async () => {
    const custom = await prisma.role.create({ data: { id: newId(), key: `PEOPLE_OPS_${Date.now()}`, name: 'People Ops' } });
    const perms = await prisma.permission.findMany({ where: { key: { in: ['user.read', 'user.manage'] } } });
    await prisma.rolePermission.createMany({ data: perms.map((p) => ({ roleId: custom.id, permissionId: p.id, scope: 'ALL' as const })) });
    const ops = await makeUser({ role: custom.key });
    const c = await clientAs(app, ops.id);

    const create = await c.post('/users', { email: uniqueEmail('esc'), name: 'Escalated', roleId: await roleId('SUPER_ADMIN') });
    expect(create.status).toBe(403);
    expect(create.body.error.message).toMatch(/cannot grant access you do not have/);

    const ok = await c.post('/users', { email: uniqueEmail('ok'), name: 'New Hire', roleId: await roleId('EMPLOYEE') });
    expect(ok.status).toBe(403); // EMPLOYEE role includes permissions People Ops itself lacks (conversation.read …)
  });

  it('nobody can grant themselves extra permissions via overrides', async () => {
    const admin = await makeUser({ role: 'SUPER_ADMIN' });
    const c = await clientAs(app, admin.id);
    const r = await c.put(`/users/${admin.id}/permission-overrides`, { overrides: [{ permissionKey: 'audit.read', effect: 'GRANT' }] });
    expect(r.status).toBe(403);
  });

  it('Super Admin role matrix cannot be edited, and admins cannot edit their own role', async () => {
    const admin = await makeUser({ role: 'SUPER_ADMIN' });
    const c = await clientAs(app, admin.id);
    const r = await c.put(`/roles/${await roleId('SUPER_ADMIN')}/permissions`, { permissions: [] });
    expect(r.status).toBe(409);
  });

  it('per-user DENY override removes access on the next request', async () => {
    const admin = await makeUser({ role: 'SUPER_ADMIN' });
    const md = await makeUser({ role: 'MD' });
    const mdClient = await clientAs(app, md.id);
    expect((await mdClient.get('/audit-logs')).status).toBe(200);
    const r = await (await clientAs(app, admin.id)).put(`/users/${md.id}/permission-overrides`, {
      overrides: [{ permissionKey: 'audit.read', effect: 'DENY', reason: 'test' }],
    });
    expect(r.status).toBe(200);
    expect(r.body['audit.read']).toBeUndefined();
    expect((await mdClient.get('/audit-logs')).status).toBe(403);
  });
});

describe('user lifecycle', () => {
  it('invite → update → role change revokes sessions → suspend → reactivate, all audited', async () => {
    const admin = await makeUser({ role: 'SUPER_ADMIN' });
    const ac = await clientAs(app, admin.id);
    const dept = await makeDepartment();

    const wrongDomain = await ac.post('/users', { email: 'someone@yahoo.com', name: 'X', roleId: await roleId('EMPLOYEE') });
    expect(wrongDomain.status).toBe(422);

    const created = await ac.post('/users', { email: uniqueEmail('hire'), name: 'New Hire', roleId: await roleId('EMPLOYEE'), departmentId: dept.id });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('INVITED');
    const id = created.body.id as string;

    const dup = await ac.post('/users', { email: created.body.email, name: 'Dup', roleId: await roleId('EMPLOYEE') });
    expect(dup.status).toBe(409);

    // An invited employee who never signed in goes back to INVITED (not ACTIVE) when reactivated.
    expect((await ac.post(`/users/${id}/suspend`)).body.status).toBe('SUSPENDED');
    expect((await ac.post(`/users/${id}/reactivate`)).body.status).toBe('INVITED');

    // Simulate their first sign-in.
    await prisma.user.update({ where: { id }, data: { status: 'ACTIVE', lastLoginAt: new Date() } });
    const hireClient = await clientAs(app, id);
    expect((await hireClient.get('/auth/me')).status).toBe(200);

    const promoted = await ac.patch(`/users/${id}`, { roleId: await roleId('TEAM_LEADER') });
    expect(promoted.body.role.key).toBe('TEAM_LEADER');
    expect((await hireClient.get('/auth/me')).status).toBe(401); // sessions revoked on role change

    const again = await clientAs(app, id);
    expect((await ac.post(`/users/${id}/suspend`)).body.status).toBe('SUSPENDED');
    expect((await again.get('/auth/me')).status).toBe(401);
    expect((await ac.post(`/users/${id}/reactivate`)).body.status).toBe('ACTIVE');

    const actions = (await prisma.auditLog.findMany({ where: { entityId: id }, orderBy: { createdAt: 'asc' } })).map((a) => a.action);
    expect(actions).toEqual(['user.create', 'user.suspend', 'user.reactivate', 'user.role_change', 'user.suspend', 'user.reactivate']);
    const roleChange = await prisma.auditLog.findFirstOrThrow({ where: { entityId: id, action: 'user.role_change' } });
    expect(roleChange.actorId).toBe(admin.id);
    expect(Object.keys(roleChange.after as object)).toEqual(['roleId']);
  });

  it('protects the last active Super Admin and blocks self-suspension', async () => {
    // Make every other Super Admin inactive for this check, then restore.
    const others = await prisma.user.findMany({ where: { status: 'ACTIVE', role: { key: 'SUPER_ADMIN' } }, select: { id: true } });
    await prisma.user.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { status: 'DEACTIVATED' } });
    try {
      const only = await makeUser({ role: 'SUPER_ADMIN' });
      const c = await clientAs(app, only.id);
      expect((await c.post(`/users/${only.id}/suspend`)).status).toBe(409);
      const demote = await c.patch(`/users/${only.id}`, { roleId: await roleId('MD') });
      expect(demote.status).toBe(409);
      expect(demote.body.error.code).toBe('LAST_SUPER_ADMIN');
    } finally {
      await prisma.user.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { status: 'ACTIVE' } });
    }
  });

  it('employees can set their own absence but not someone else’s', async () => {
    const a = await makeUser({ role: 'EMPLOYEE' });
    const b = await makeUser({ role: 'EMPLOYEE' });
    const c = await clientAs(app, a.id);
    const until = new Date(Date.now() + 86_400_000).toISOString();
    expect((await c.put(`/users/${a.id}/absence`, { isAbsent: true, absentUntil: until })).body.isAbsent).toBe(true);
    expect((await c.put(`/users/${b.id}/absence`, { isAbsent: true })).status).toBe(403);
  });
});

describe('departments and teams', () => {
  it('creates, manages membership and refuses to delete a department in use', async () => {
    const admin = await makeUser({ role: 'SUPER_ADMIN' });
    const c = await clientAs(app, admin.id);
    const slug = `sales-${Date.now()}`;
    const d = await c.post('/departments', { name: 'Sales', slug });
    expect(d.status).toBe(201);
    expect((await c.post('/departments', { name: 'Sales 2', slug })).status).toBe(409);
    expect((await c.post('/departments', { name: 'Bad', slug: 'Not A Slug' })).status).toBe(422);

    const t = await c.post('/teams', { name: 'Inbound', departmentId: d.body.id });
    expect(t.status).toBe(201);
    const member = await makeUser({ role: 'SALES', departmentId: d.body.id });
    const m = await c.put(`/teams/${t.body.id}/members`, { userId: member.id, inRotation: false });
    expect(m.body.members).toEqual([expect.objectContaining({ userId: member.id, inRotation: false })]);

    const del = await c.del(`/departments/${d.body.id}`);
    expect(del.status).toBe(409);
    expect(del.body.error.code).toBe('IN_USE');

    const list = await c.get('/departments');
    const found = list.body.find((x: { id: string }) => x.id === d.body.id);
    expect(found.teams[0].members).toHaveLength(1);
  });
});

describe('audit log integrity', () => {
  it('cannot be modified or deleted, even with direct SQL', async () => {
    const row = await prisma.auditLog.findFirstOrThrow({ orderBy: { createdAt: 'desc' } });
    await expect(prisma.auditLog.update({ where: { id: row.id }, data: { action: 'tampered' } })).rejects.toThrow(/append-only/);
    await expect(prisma.auditLog.delete({ where: { id: row.id } })).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe('TRUNCATE audit_logs')).rejects.toThrow(/cannot be truncated/);
  });

  it('database runs in UTC so DB-side timestamps match app-written ones', async () => {
    const [tz] = await prisma.$queryRawUnsafe<{ TimeZone: string }[]>('SHOW timezone');
    expect(tz!.TimeZone).toBe('UTC');
    const id = newId();
    await prisma.$executeRawUnsafe(`INSERT INTO audit_logs (id, "actorType", action, "entityType") VALUES ($1, 'SYSTEM', 'test.clock', 'test')`, id);
    const row = await prisma.auditLog.findUniqueOrThrow({ where: { id } });
    expect(Math.abs(row.createdAt.getTime() - Date.now())).toBeLessThan(60_000);
  });

  it('never stores secrets in snapshots', async () => {
    const rows = await prisma.auditLog.findMany({ take: 500, orderBy: { createdAt: 'desc' } });
    const text = JSON.stringify(rows);
    expect(text).not.toMatch(/\$argon2/);
    expect(text).not.toMatch(/"passwordHash":"(?!\[redacted\])/);
  });
});

describe('permission cache (Phase 10)', () => {
  it('reuses permissions between requests, but a change through the API applies at once', async () => {
    const { bootApp: boot, clientAs: as, makeUser: mk } = await import('./helpers');
    const { app: a } = await boot({ env: { PERMISSION_CACHE_SECONDS: '30' } });
    try {
      const adminC = await as(a, (await mk({ role: 'SUPER_ADMIN' })).id);
      const emp = await mk({ role: 'EMPLOYEE' });
      const c = await as(a, emp.id);
      expect((await c.get('/audit-logs')).status).toBe(403);
      const r = await adminC.put(`/users/${emp.id}/permission-overrides`, { overrides: [{ permissionKey: 'audit.read', effect: 'GRANT', scope: 'ALL', reason: 'audit' }] });
      expect(r.status).toBe(200);
      expect((await c.get('/audit-logs')).status).toBe(200);
      await adminC.put(`/users/${emp.id}/permission-overrides`, { overrides: [] });
      expect((await c.get('/audit-logs')).status).toBe(403);
    } finally {
      await a.close();
    }
  });
});
