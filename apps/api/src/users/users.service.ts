import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@crm/db';
import { newId } from '@crm/crypto';
import type {
  CreateUserInput,
  PermissionKey,
  PermissionOverridesInput,
  Scope,
  UpdateUserInput,
  UserSummary,
} from '@crm/shared';
import type { z } from 'zod';
import type { absenceSchema, listUsersQuery, updateSelfSchema } from '@crm/shared';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { AuditService, diff } from '../audit/audit.service';
import { AccessPolicy } from '../access/access-policy.service';
import { PermissionService } from '../access/permission.service';
import { QueueService } from '../mail/queue.service';
import { assertCanGrant } from '../access/grant-guard';
import { SessionService } from '../auth/session.service';
import { allowedLoginEmailHint, classifyLoginEmail } from '../auth/login-policy';
import { Errors } from '../common/errors';
import type { RequestContext } from '../common/request-context';

const include = {
  role: { select: { id: true, key: true, name: true } },
  department: { select: { id: true, name: true } },
  manager: { select: { id: true, name: true } },
} satisfies Prisma.UserInclude;

type UserRow = Prisma.UserGetPayload<{ include: typeof include }>;

export function toSummary(u: UserRow): UserSummary {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    status: u.status,
    timezone: u.timezone,
    isAbsent: u.isAbsent,
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    mfaEnabled: !!u.mfaEnabledAt,
    hasPassword: !!u.passwordHash,
    role: u.role,
    department: u.department,
    manager: u.manager,
    createdAt: u.createdAt.toISOString(),
  };
}

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessPolicy,
    private readonly perms: PermissionService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly queue: QueueService,
  ) {}

  async list(ctx: RequestContext, q: z.infer<typeof listUsersQuery>) {
    const scope = await this.access.userWhere(ctx);
    const filters: Prisma.UserWhereInput[] = [scope];
    if (q.status) filters.push({ status: q.status });
    if (q.departmentId) filters.push({ departmentId: q.departmentId });
    if (q.roleId) filters.push({ roleId: q.roleId });
    if (q.q) filters.push({ OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { email: { contains: q.q, mode: 'insensitive' } }] });
    const rows = await this.prisma.user.findMany({
      where: { AND: filters },
      include,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const more = rows.length > q.limit;
    const items = rows.slice(0, q.limit);
    return { items: items.map(toSummary), nextCursor: more ? items[items.length - 1]!.id : null };
  }

  /** Scoped fetch — users outside the caller's scope are reported as not found. */
  async get(ctx: RequestContext, id: string) {
    const u = await this.prisma.user.findFirst({ where: { AND: [{ id }, await this.access.userWhere(ctx)] }, include });
    if (!u) throw Errors.notFound('Employee');
    return toSummary(u);
  }

  private async rolePerms(db: Tx, roleId: string) {
    const role = await db.role.findUnique({ where: { id: roleId }, include: { permissions: { include: { permission: true } } } });
    if (!role) throw Errors.validation([{ path: 'roleId', message: 'Unknown role' }]);
    return { role, grants: role.permissions.map((p) => ({ key: p.permission.key as PermissionKey, scope: p.scope as Scope })) };
  }

  private async assertRefs(db: Tx, input: { departmentId?: string | null; managerId?: string | null }, selfId?: string) {
    if (input.departmentId && !(await db.department.findUnique({ where: { id: input.departmentId } }))) {
      throw Errors.validation([{ path: 'departmentId', message: 'Unknown department' }]);
    }
    if (input.managerId) {
      if (input.managerId === selfId) throw Errors.validation([{ path: 'managerId', message: 'An employee cannot manage themselves' }]);
      if (!(await db.user.findUnique({ where: { id: input.managerId } }))) {
        throw Errors.validation([{ path: 'managerId', message: 'Unknown manager' }]);
      }
    }
  }

  private assertLoginEmail(email: string) {
    if (!classifyLoginEmail(this.cfg, email)) {
      throw Errors.validation([{ path: 'email', message: `Use ${allowedLoginEmailHint(this.cfg)}` }]);
    }
  }

  /** Prevents locking everyone out: there must always be one active Super Admin. */
  private async assertNotLastSuperAdmin(db: Tx, userId: string) {
    const target = await db.user.findUniqueOrThrow({ where: { id: userId }, include: { role: true } });
    if (target.role.key !== 'SUPER_ADMIN' || target.status !== 'ACTIVE') return;
    const others = await db.user.count({ where: { id: { not: userId }, status: 'ACTIVE', role: { key: 'SUPER_ADMIN' } } });
    if (others === 0) throw Errors.conflict('This is the only active Super Admin — appoint another one first', 'LAST_SUPER_ADMIN');
  }

  async create(ctx: RequestContext, input: CreateUserInput) {
    this.assertLoginEmail(input.email);
    return this.prisma.$transaction(async (tx) => {
      const { grants } = await this.rolePerms(tx, input.roleId);
      assertCanGrant(ctx, grants);
      await this.assertRefs(tx, input);
      const u = await tx.user.create({
        data: {
          id: newId(),
          email: input.email,
          name: input.name,
          roleId: input.roleId,
          departmentId: input.departmentId ?? null,
          managerId: input.managerId ?? null,
          timezone: input.timezone ?? 'UTC',
          status: 'INVITED',
        },
        include,
      });
      await this.audit.record(tx, ctx, { action: 'user.create', entityType: 'user', entityId: u.id, after: toSummary(u) });
      return toSummary(u);
    });
  }

  async update(ctx: RequestContext, id: string, input: UpdateUserInput) {
    const out = await this.prisma.$transaction(async (tx) => {
      const before = await tx.user.findUnique({ where: { id } });
      if (!before) throw Errors.notFound('Employee');
      await this.assertRefs(tx, input, id);
      const roleChanged = input.roleId !== undefined && input.roleId !== before.roleId;
      if (roleChanged) {
        const { grants } = await this.rolePerms(tx, input.roleId!);
        assertCanGrant(ctx, grants);
        await this.assertNotLastSuperAdmin(tx, id);
      }
      const d = diff(before as unknown as Record<string, unknown>, input);
      if (!d.changed) return toSummary(await tx.user.findUniqueOrThrow({ where: { id }, include }));
      const u = await tx.user.update({ where: { id }, data: input, include });
      if (roleChanged) await this.sessions.revokeAllForUser(tx, id);
      await this.audit.record(tx, ctx, {
        action: roleChanged ? 'user.role_change' : 'user.update',
        entityType: 'user',
        entityId: id,
        before: d.before,
        after: d.after,
      });
      return toSummary(u);
    });
    this.perms.invalidate(id);
    return out;
  }

  async updateSelf(ctx: RequestContext, input: z.infer<typeof updateSelfSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.user.findUniqueOrThrow({ where: { id: ctx.userId } });
      const d = diff(before as unknown as Record<string, unknown>, input);
      const u = await tx.user.update({ where: { id: ctx.userId }, data: input, include });
      if (d.changed) await this.audit.record(tx, ctx, { action: 'user.update_self', entityType: 'user', entityId: ctx.userId, before: d.before, after: d.after });
      return toSummary(u);
    });
  }

  async setStatus(ctx: RequestContext, id: string, action: 'suspend' | 'reactivate') {
    if (action === 'suspend' && id === ctx.userId) throw Errors.conflict('You cannot suspend your own account');
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.user.findUnique({ where: { id } });
      if (!before) throw Errors.notFound('Employee');
      let status: UserSummary['status'];
      if (action === 'suspend') {
        await this.assertNotLastSuperAdmin(tx, id);
        status = 'SUSPENDED';
      } else {
        // Back to ACTIVE only if they have signed in before (or have a password); otherwise still INVITED.
        const identities = await tx.userIdentity.count({ where: { userId: id } });
        status = before.lastLoginAt || before.passwordHash || identities ? 'ACTIVE' : 'INVITED';
      }
      const u = await tx.user.update({
        where: { id },
        data: { status, ...(action === 'reactivate' ? { failedLoginCount: 0, lockedUntil: null } : {}) },
        include,
      });
      const revoked = action === 'suspend' ? await this.sessions.revokeAllForUser(tx, id) : 0;
      await this.audit.record(tx, ctx, {
        action: `user.${action}`,
        entityType: 'user',
        entityId: id,
        before: { status: before.status },
        after: { status },
        metadata: action === 'suspend' ? { sessionsRevoked: revoked } : undefined,
      });
      return toSummary(u);
    });
  }

  async resetMfa(ctx: RequestContext, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const r = await tx.user.updateMany({ where: { id }, data: { mfaEnabledAt: null, mfaSecretEnc: null, mfaLastUsedStep: null } });
      if (r.count === 0) throw Errors.notFound('Employee');
      await this.sessions.revokeAllForUser(tx, id);
      await this.audit.record(tx, ctx, { action: 'user.mfa_reset', entityType: 'user', entityId: id });
    });
  }

  async setAbsence(ctx: RequestContext, id: string, input: z.infer<typeof absenceSchema>) {
    if (id !== ctx.userId && !ctx.permissions['user.manage']) throw Errors.forbidden();
    const result = await this.prisma.$transaction(async (tx) => {
      const before = await tx.user.findUnique({ where: { id } });
      if (!before) throw Errors.notFound('Employee');
      const data = { isAbsent: input.isAbsent, absentUntil: input.isAbsent ? (input.absentUntil ?? null) : null };
      const u = await tx.user.update({ where: { id }, data, include });
      await this.audit.record(tx, ctx, {
        action: 'user.absence',
        entityType: 'user',
        entityId: id,
        before: { isAbsent: before.isAbsent, absentUntil: before.absentUntil },
        after: data,
      });
      return { summary: toSummary(u), becameAbsent: !before.isAbsent && data.isAbsent };
    });
    // Absence reassignment and other USER_ABSENT automation rules (worker).
    if (result.becameAbsent) await this.queue.enqueueAutomation({ trigger: 'USER_ABSENT', eventKey: `absent:${id}:${Date.now()}`, userId: id }).catch(() => undefined);
    return result.summary;
  }

  async getOverrides(id: string) {
    const rows = await this.prisma.userPermissionOverride.findMany({ where: { userId: id }, include: { permission: true } });
    return rows.map((o) => ({
      permissionKey: o.permission.key,
      effect: o.effect,
      scope: o.scope,
      reason: o.reason,
      expiresAt: o.expiresAt?.toISOString() ?? null,
    }));
  }

  /** Replaces the full override set for a user. */
  async setOverrides(ctx: RequestContext, id: string, input: PermissionOverridesInput) {
    assertCanGrant(
      ctx,
      input.overrides.filter((o) => o.effect === 'GRANT').map((o) => ({ key: o.permissionKey, scope: (o.scope ?? 'OWN') as Scope })),
    );
    const out = await this.prisma.$transaction(async (tx) => {
      if (!(await tx.user.findUnique({ where: { id } }))) throw Errors.notFound('Employee');
      if (id === ctx.userId && input.overrides.some((o) => o.effect === 'GRANT')) {
        throw Errors.forbidden('You cannot grant extra permissions to yourself');
      }
      const before = await this.getOverrides(id);
      const permissions = await tx.permission.findMany({ where: { key: { in: input.overrides.map((o) => o.permissionKey) } } });
      const idByKey = new Map(permissions.map((p) => [p.key, p.id]));
      await tx.userPermissionOverride.deleteMany({ where: { userId: id } });
      if (input.overrides.length) {
        await tx.userPermissionOverride.createMany({
          data: input.overrides.map((o) => ({
            userId: id,
            permissionId: idByKey.get(o.permissionKey)!,
            effect: o.effect,
            scope: o.effect === 'GRANT' ? (o.scope ?? null) : null,
            reason: o.reason ?? null,
            expiresAt: o.expiresAt ?? null,
            grantedById: ctx.userId,
          })),
        });
      }
      await this.audit.record(tx, ctx, { action: 'user.permission_overrides', entityType: 'user', entityId: id, before, after: input.overrides });
      return this.perms.effectiveFor(id, tx);
    });
    this.perms.invalidate(id);
    return out;
  }
}
