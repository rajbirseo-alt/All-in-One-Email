import { Injectable } from '@nestjs/common';
import type { Prisma } from '@crm/db';
import type { PermissionKey } from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestContext } from '../common/request-context';

const NOTHING = { id: { in: [] as string[] } };

/**
 * Turns (user, permission) into Prisma `where` fragments. Services merge these into every
 * query — list and single-record alike — so out-of-scope records behave as non-existent.
 * Conversation/contact/lead policies are added in the phases that introduce those modules.
 */
@Injectable()
export class AccessPolicy {
  constructor(private readonly prisma: PrismaService) {}

  /** Departments the user belongs to or manages. */
  async departmentIds(ctx: RequestContext): Promise<string[]> {
    const managed = await this.prisma.department.findMany({ where: { managerId: ctx.userId }, select: { id: true } });
    const ids = new Set(managed.map((d) => d.id));
    if (ctx.departmentId) ids.add(ctx.departmentId);
    return [...ids];
  }

  /** Teams the user is a member of or leads. */
  async teamIds(ctx: RequestContext): Promise<string[]> {
    const [member, led] = await Promise.all([
      this.prisma.teamMember.findMany({ where: { userId: ctx.userId }, select: { teamId: true } }),
      this.prisma.team.findMany({ where: { leaderId: ctx.userId }, select: { id: true } }),
    ]);
    return [...new Set([...member.map((m) => m.teamId), ...led.map((t) => t.id)])];
  }

  /** Which employee records the caller may see for `permission` (default user.read). */
  async userWhere(ctx: RequestContext, permission: PermissionKey = 'user.read'): Promise<Prisma.UserWhereInput> {
    const scope = ctx.permissions[permission];
    switch (scope) {
      case 'ALL':
        return {};
      case 'DEPARTMENT': {
        const depts = await this.departmentIds(ctx);
        return { OR: [{ id: ctx.userId }, { departmentId: { in: depts } }] };
      }
      case 'TEAM': {
        const teams = await this.teamIds(ctx);
        return {
          OR: [
            { id: ctx.userId },
            { teamMemberships: { some: { teamId: { in: teams } } } },
            { ledTeams: { some: { id: { in: teams } } } },
          ],
        };
      }
      case 'ASSIGNED':
      case 'OWN':
        return { id: ctx.userId };
      default:
        return NOTHING;
    }
  }

  /** Departments visible to the caller: org admins / ALL see all; others see their own. */
  async departmentWhere(ctx: RequestContext): Promise<Prisma.DepartmentWhereInput> {
    if (ctx.permissions['org.manage'] || ctx.permissions['user.read'] === 'ALL') return {};
    const scope = ctx.permissions['user.read'];
    if (!scope) return NOTHING;
    if (scope === 'TEAM' || scope === 'OWN' || scope === 'ASSIGNED') {
      const teams = await this.teamIds(ctx);
      const viaTeams = await this.prisma.team.findMany({ where: { id: { in: teams } }, select: { departmentId: true } });
      const ids = new Set(viaTeams.map((t) => t.departmentId));
      if (ctx.departmentId) ids.add(ctx.departmentId);
      return { id: { in: [...ids] } };
    }
    return { id: { in: await this.departmentIds(ctx) } };
  }
}
