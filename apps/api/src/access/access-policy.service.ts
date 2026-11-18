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

  /**
   * Which conversations the caller may see for `permission` (docs/05 §4). Each wider scope
   * includes the narrower rules. A mailbox grant widens access to that mailbox only.
   * DEPARTMENT also covers threads of a mailbox assigned to the user's department.
   */
  async threadWhere(ctx: RequestContext, permission: PermissionKey = 'conversation.read'): Promise<Prisma.EmailThreadWhereInput> {
    const scope = ctx.permissions[permission];
    if (scope === 'ALL') return {};
    if (!scope || scope === 'OWN') return NOTHING;

    const or: Prisma.EmailThreadWhereInput[] = [
      { assigneeId: ctx.userId },
      { shares: { some: { userId: ctx.userId } } },
      { notes: { some: { deletedAt: null, mentions: { some: { userId: ctx.userId } } } } },
      { emailAccount: { access: { some: { userId: ctx.userId } } } },
    ];
    if (scope === 'TEAM' || scope === 'DEPARTMENT') {
      const teams = await this.teamIds(ctx);
      const led = await this.prisma.teamMember.findMany({ where: { team: { leaderId: ctx.userId } }, select: { userId: true } });
      or.push({ teamId: { in: teams } }, { assigneeId: { in: led.map((m) => m.userId) } }, { emailAccount: { access: { some: { teamId: { in: teams } } } } });
    }
    if (scope === 'DEPARTMENT') {
      const depts = await this.departmentIds(ctx);
      or.push(
        { departmentId: { in: depts } },
        { emailAccount: { departmentId: { in: depts } } },
        { emailAccount: { access: { some: { departmentId: { in: depts } } } } },
      );
    }
    return { OR: or };
  }

  /**
   * Whether the caller may send from this thread's mailbox: `conversation.reply` must cover the
   * thread, and (unless the scope is ALL) the caller needs REPLY/MANAGE on the mailbox for
   * themselves, their team or department, or the thread is assigned to them or shared with reply.
   */
  async canReply(ctx: RequestContext, thread: { id: string; emailAccountId: string; assigneeId: string | null }): Promise<boolean> {
    const scope = ctx.permissions['conversation.reply'];
    if (!scope) return false;
    if (scope === 'ALL') return true;
    const visible = await this.prisma.emailThread.count({ where: { AND: [{ id: thread.id }, await this.threadWhere(ctx, 'conversation.reply')] } });
    if (!visible) return false;
    if (thread.assigneeId === ctx.userId) return true;
    if (await this.prisma.threadShare.count({ where: { threadId: thread.id, userId: ctx.userId, canReply: true } })) return true;
    return this.canSendFrom(ctx, thread.emailAccountId);
  }

  /** REPLY or MANAGE grant on the mailbox for the user, one of their teams or departments (ALL scope always). */
  async canSendFrom(ctx: RequestContext, emailAccountId: string): Promise<boolean> {
    if (ctx.permissions['conversation.reply'] === 'ALL') return true;
    if (!ctx.permissions['conversation.reply']) return false;
    const [teams, depts] = await Promise.all([this.teamIds(ctx), this.departmentIds(ctx)]);
    return (
      (await this.prisma.emailAccountAccess.count({
        where: {
          emailAccountId,
          level: { in: ['REPLY', 'MANAGE'] },
          OR: [{ userId: ctx.userId }, { teamId: { in: teams } }, { departmentId: { in: depts } }],
        },
      })) > 0
    );
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
