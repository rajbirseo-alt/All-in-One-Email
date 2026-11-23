import { Injectable } from '@nestjs/common';
import { newId } from '@crm/crypto';
import { GLOBAL_PERMISSIONS, PERMISSIONS, type PermissionKey, type RoleDetail, type RolePermissionsInput, type Scope } from '@crm/shared';
import type { z } from 'zod';
import type { createRoleSchema, updateRoleSchema } from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionService } from '../access/permission.service';
import { AuditService, diff } from '../audit/audit.service';
import { assertCanGrant } from '../access/grant-guard';
import { Errors } from '../common/errors';
import type { RequestContext } from '../common/request-context';

@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly perms: PermissionService,
  ) {}

  catalogue() {
    return Object.entries(PERMISSIONS).map(([key, description]) => ({
      key,
      description,
      global: GLOBAL_PERMISSIONS.has(key as PermissionKey),
    }));
  }

  async list(): Promise<RoleDetail[]> {
    const roles = await this.prisma.role.findMany({
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
      include: { permissions: { include: { permission: true } }, _count: { select: { users: true } } },
    });
    return roles.map((r) => ({
      id: r.id,
      key: r.key,
      name: r.name,
      description: r.description,
      isSystem: r.isSystem,
      userCount: r._count.users,
      permissions: r.permissions.map((p) => ({ permissionKey: p.permission.key, scope: p.scope })),
    }));
  }

  async create(ctx: RequestContext, input: z.infer<typeof createRoleSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const r = await tx.role.create({ data: { id: newId(), key: input.key, name: input.name, description: input.description ?? null } });
      await this.audit.record(tx, ctx, { action: 'role.create', entityType: 'role', entityId: r.id, after: r });
      return r;
    });
  }

  async update(ctx: RequestContext, id: string, input: z.infer<typeof updateRoleSchema>) {
    return this.afterChange(this.prisma.$transaction(async (tx) => {
      const before = await tx.role.findUnique({ where: { id } });
      if (!before) throw Errors.notFound('Role');
      const r = await tx.role.update({ where: { id }, data: input });
      const d = diff(before as unknown as Record<string, unknown>, input);
      if (d.changed) await this.audit.record(tx, ctx, { action: 'role.update', entityType: 'role', entityId: id, before: d.before, after: d.after });
      return r;
    }));
  }

  /** Cached permissions of everyone are dropped once a role change has committed. */
  private async afterChange<T>(p: Promise<T>): Promise<T> {
    const r = await p;
    this.perms.invalidate();
    return r;
  }

  async remove(ctx: RequestContext, id: string) {
    await this.afterChange(this.prisma.$transaction(async (tx) => {
      const r = await tx.role.findUnique({ where: { id }, include: { _count: { select: { users: true } } } });
      if (!r) throw Errors.notFound('Role');
      if (r.isSystem) throw Errors.conflict('System roles cannot be deleted');
      if (r._count.users > 0) throw Errors.conflict(`Move the ${r._count.users} employee(s) with this role to another role first`, 'IN_USE');
      await tx.role.delete({ where: { id } });
      await this.audit.record(tx, ctx, { action: 'role.delete', entityType: 'role', entityId: id, before: { key: r.key, name: r.name } });
    }));
  }

  /** Replaces the role's permission matrix. Takes effect on each member's next request. */
  async setPermissions(ctx: RequestContext, id: string, input: RolePermissionsInput) {
    const grants = input.permissions.map((p) => ({
      key: p.permissionKey,
      scope: (GLOBAL_PERMISSIONS.has(p.permissionKey) ? 'ALL' : p.scope) as Scope,
    }));
    assertCanGrant(ctx, grants);
    await this.afterChange(this.prisma.$transaction(async (tx) => {
      const role = await tx.role.findUnique({ where: { id }, include: { permissions: { include: { permission: true } } } });
      if (!role) throw Errors.notFound('Role');
      if (role.key === 'SUPER_ADMIN') throw Errors.conflict('Super Admin always has complete access and cannot be edited');
      if (role.id === (await tx.user.findUniqueOrThrow({ where: { id: ctx.userId } })).roleId) {
        throw Errors.conflict('You cannot change the permissions of your own role');
      }
      const perms = await tx.permission.findMany({ where: { key: { in: grants.map((g) => g.key) } } });
      const idByKey = new Map(perms.map((p) => [p.key, p.id]));
      await tx.rolePermission.deleteMany({ where: { roleId: id } });
      if (grants.length) {
        await tx.rolePermission.createMany({ data: grants.map((g) => ({ roleId: id, permissionId: idByKey.get(g.key)!, scope: g.scope })) });
      }
      await tx.role.update({ where: { id }, data: { updatedAt: new Date() } });
      await this.audit.record(tx, ctx, {
        action: 'role.permissions',
        entityType: 'role',
        entityId: id,
        before: role.permissions.map((p) => ({ permissionKey: p.permission.key, scope: p.scope })),
        after: grants.map((g) => ({ permissionKey: g.key, scope: g.scope })),
      });
    }));
    return (await this.list()).find((r) => r.id === id)!;
  }
}
