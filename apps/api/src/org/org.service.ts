import { Injectable } from '@nestjs/common';
import { newId } from '@crm/crypto';
import type { DepartmentDetail, TeamDetail } from '@crm/shared';
import type { createDepartmentSchema, createTeamSchema, teamMemberSchema, updateDepartmentSchema, updateTeamSchema } from '@crm/shared';
import type { Prisma } from '@crm/db';
import type { z } from 'zod';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { AuditService, diff } from '../audit/audit.service';
import { AccessPolicy } from '../access/access-policy.service';
import { Errors } from '../common/errors';
import type { RequestContext } from '../common/request-context';

const teamInclude = {
  leader: { select: { id: true, name: true } },
  members: { include: { user: { select: { id: true, name: true, email: true } } }, orderBy: { user: { name: 'asc' } } },
} satisfies Prisma.TeamInclude;

type TeamRow = Prisma.TeamGetPayload<{ include: typeof teamInclude }>;

const toTeam = (t: TeamRow): TeamDetail => ({
  id: t.id,
  name: t.name,
  departmentId: t.departmentId,
  leader: t.leader,
  members: t.members.map((m) => ({ userId: m.user.id, name: m.user.name, email: m.user.email, inRotation: m.inRotation })),
});

@Injectable()
export class OrgService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: AccessPolicy,
  ) {}

  async listDepartments(ctx: RequestContext): Promise<DepartmentDetail[]> {
    const rows = await this.prisma.department.findMany({
      where: await this.access.departmentWhere(ctx),
      orderBy: { name: 'asc' },
      include: {
        manager: { select: { id: true, name: true } },
        teams: { include: teamInclude, orderBy: { name: 'asc' } },
        _count: { select: { members: true } },
      },
    });
    return rows.map((d) => ({
      id: d.id,
      name: d.name,
      slug: d.slug,
      manager: d.manager,
      memberCount: d._count.members,
      teams: d.teams.map(toTeam),
    }));
  }

  private async assertUser(db: Tx, id: string | null | undefined, path: string) {
    if (id && !(await db.user.findUnique({ where: { id } }))) throw Errors.validation([{ path, message: 'Unknown employee' }]);
  }

  async createDepartment(ctx: RequestContext, input: z.infer<typeof createDepartmentSchema>) {
    return this.prisma.$transaction(async (tx) => {
      await this.assertUser(tx, input.managerId, 'managerId');
      const d = await tx.department.create({ data: { id: newId(), name: input.name, slug: input.slug, managerId: input.managerId ?? null } });
      await this.audit.record(tx, ctx, { action: 'department.create', entityType: 'department', entityId: d.id, after: d });
      return d;
    });
  }

  async updateDepartment(ctx: RequestContext, id: string, input: z.infer<typeof updateDepartmentSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.department.findUnique({ where: { id } });
      if (!before) throw Errors.notFound('Department');
      await this.assertUser(tx, input.managerId, 'managerId');
      const d = await tx.department.update({ where: { id }, data: input });
      const dd = diff(before as unknown as Record<string, unknown>, input);
      if (dd.changed) await this.audit.record(tx, ctx, { action: 'department.update', entityType: 'department', entityId: id, before: dd.before, after: dd.after });
      return d;
    });
  }

  async deleteDepartment(ctx: RequestContext, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const d = await tx.department.findUnique({
        where: { id },
        include: { _count: { select: { members: true, teams: true, emailAccounts: true } } },
      });
      if (!d) throw Errors.notFound('Department');
      const c = d._count;
      if (c.members || c.teams || c.emailAccounts) {
        throw Errors.conflict(
          `Department still has ${c.members} employee(s), ${c.teams} team(s) and ${c.emailAccounts} mailbox(es) — move them first`,
          'IN_USE',
        );
      }
      await tx.department.delete({ where: { id } });
      await this.audit.record(tx, ctx, { action: 'department.delete', entityType: 'department', entityId: id, before: { name: d.name, slug: d.slug } });
    });
  }

  async createTeam(ctx: RequestContext, input: z.infer<typeof createTeamSchema>) {
    return this.prisma.$transaction(async (tx) => {
      if (!(await tx.department.findUnique({ where: { id: input.departmentId } }))) {
        throw Errors.validation([{ path: 'departmentId', message: 'Unknown department' }]);
      }
      await this.assertUser(tx, input.leaderId, 'leaderId');
      const t = await tx.team.create({
        data: { id: newId(), name: input.name, departmentId: input.departmentId, leaderId: input.leaderId ?? null },
        include: teamInclude,
      });
      await this.audit.record(tx, ctx, { action: 'team.create', entityType: 'team', entityId: t.id, after: { name: t.name, departmentId: t.departmentId, leaderId: t.leaderId } });
      return toTeam(t);
    });
  }

  async updateTeam(ctx: RequestContext, id: string, input: z.infer<typeof updateTeamSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.team.findUnique({ where: { id } });
      if (!before) throw Errors.notFound('Team');
      await this.assertUser(tx, input.leaderId, 'leaderId');
      const t = await tx.team.update({ where: { id }, data: input, include: teamInclude });
      const d = diff(before as unknown as Record<string, unknown>, input);
      if (d.changed) await this.audit.record(tx, ctx, { action: 'team.update', entityType: 'team', entityId: id, before: d.before, after: d.after });
      return toTeam(t);
    });
  }

  async deleteTeam(ctx: RequestContext, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const t = await tx.team.findUnique({ where: { id }, include: { _count: { select: { threads: true, mailboxAccess: true } } } });
      if (!t) throw Errors.notFound('Team');
      if (t._count.threads || t._count.mailboxAccess) {
        throw Errors.conflict('This team still owns conversations or mailbox access — reassign them first', 'IN_USE');
      }
      await tx.team.delete({ where: { id } });
      await this.audit.record(tx, ctx, { action: 'team.delete', entityType: 'team', entityId: id, before: { name: t.name } });
    });
  }

  async upsertMember(ctx: RequestContext, teamId: string, input: z.infer<typeof teamMemberSchema>) {
    return this.prisma.$transaction(async (tx) => {
      if (!(await tx.team.findUnique({ where: { id: teamId } }))) throw Errors.notFound('Team');
      await this.assertUser(tx, input.userId, 'userId');
      await tx.teamMember.upsert({
        where: { teamId_userId: { teamId, userId: input.userId } },
        create: { teamId, userId: input.userId, inRotation: input.inRotation },
        update: { inRotation: input.inRotation },
      });
      await this.audit.record(tx, ctx, { action: 'team.member_set', entityType: 'team', entityId: teamId, after: input });
      return toTeam(await tx.team.findUniqueOrThrow({ where: { id: teamId }, include: teamInclude }));
    });
  }

  async removeMember(ctx: RequestContext, teamId: string, userId: string) {
    return this.prisma.$transaction(async (tx) => {
      const r = await tx.teamMember.deleteMany({ where: { teamId, userId } });
      if (r.count === 0) throw Errors.notFound('Team member');
      await this.audit.record(tx, ctx, { action: 'team.member_remove', entityType: 'team', entityId: teamId, before: { userId } });
      return toTeam(await tx.team.findUniqueOrThrow({ where: { id: teamId }, include: teamInclude }));
    });
  }
}
