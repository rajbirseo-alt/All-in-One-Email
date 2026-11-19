import { Injectable } from '@nestjs/common';
import type { Prisma } from '@crm/db';
import type { PermissionKey } from '@crm/shared';
import { AccessPolicy } from '../access/access-policy.service';
import type { RequestContext } from '../common/request-context';
import { PrismaService } from '../prisma/prisma.service';

const NOTHING = { id: { in: [] as string[] } };

/**
 * Which contacts, leads and tasks a caller may see or change (docs/05 §4). Like conversations,
 * records outside the scope behave as if they did not exist (404).
 *
 * - Contacts: OWN = contacts they own; TEAM / DEPARTMENT add contacts owned by those people
 *   (DEPARTMENT also contacts filed under the department). At every scope, the contact of a
 *   conversation the caller can read, or of a lead they can read, is visible too: whoever handles
 *   the conversation sees who it is with. Merged contacts are hidden.
 * - Leads: OWN = their own; TEAM adds leads owned by team members and leads from the team's
 *   queue; DEPARTMENT adds the department's leads.
 * - Tasks: OWN = assigned to them or created by them; TEAM / DEPARTMENT add tasks of those people.
 */
@Injectable()
export class CrmAccess {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessPolicy,
  ) {}

  async contactWhere(ctx: RequestContext, permission: 'contact.read' | 'contact.write' = 'contact.read'): Promise<Prisma.ContactWhereInput> {
    const scope = ctx.permissions[permission];
    if (!scope) return NOTHING;
    if (scope === 'ALL') return { mergedIntoId: null };
    const or: Prisma.ContactWhereInput[] = [{ ownerId: ctx.userId }];
    if (scope === 'TEAM') or.push({ owner: await this.access.userWhere(ctx, permission) });
    if (scope === 'DEPARTMENT') {
      const depts = await this.access.departmentIds(ctx);
      or.push({ departmentId: { in: depts } }, { owner: { departmentId: { in: depts } } });
    }
    if (ctx.permissions['conversation.read']) or.push({ threads: { some: await this.access.threadWhere(ctx) } });
    if (ctx.permissions['lead.read']) or.push({ leads: { some: await this.leadWhere(ctx) } });
    return { mergedIntoId: null, OR: or };
  }

  async leadWhere(ctx: RequestContext, permission: 'lead.read' | 'lead.write' = 'lead.read'): Promise<Prisma.LeadWhereInput> {
    const scope = ctx.permissions[permission];
    if (!scope) return NOTHING;
    if (scope === 'ALL') return {};
    const or: Prisma.LeadWhereInput[] = [{ ownerId: ctx.userId }];
    if (scope === 'TEAM') {
      const teams = await this.access.teamIds(ctx);
      or.push({ owner: await this.access.userWhere(ctx, permission) }, { sourceThread: { teamId: { in: teams } } });
    }
    if (scope === 'DEPARTMENT') {
      const depts = await this.access.departmentIds(ctx);
      or.push({ departmentId: { in: depts } }, { owner: { departmentId: { in: depts } } });
    }
    return { OR: or };
  }

  async taskWhere(ctx: RequestContext, permission: 'task.read' | 'task.write' = 'task.read'): Promise<Prisma.TaskWhereInput> {
    const scope = ctx.permissions[permission];
    if (!scope) return NOTHING;
    if (scope === 'ALL') return {};
    const or: Prisma.TaskWhereInput[] = [{ assigneeId: ctx.userId }, { createdById: ctx.userId }];
    if (scope === 'TEAM' || scope === 'DEPARTMENT') or.push({ assignee: await this.access.userWhere(ctx, permission) });
    return { OR: or };
  }

  /** Active employees the caller may hand a record to under `permission` (OWN: only themselves). */
  async people(ctx: RequestContext, permission: PermissionKey) {
    if (!ctx.permissions[permission]) return [];
    return this.prisma.user.findMany({
      where: { AND: [{ status: 'ACTIVE' }, await this.access.userWhere(ctx, permission)] },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
  }

  async canHandTo(ctx: RequestContext, permission: PermissionKey, userId: string) {
    if (!ctx.permissions[permission]) return false;
    return (await this.prisma.user.count({ where: { AND: [{ id: userId, status: 'ACTIVE' }, await this.access.userWhere(ctx, permission)] } })) > 0;
  }

  async threadReadable(ctx: RequestContext, threadId: string) {
    if (!ctx.permissions['conversation.read']) return false;
    return (await this.prisma.emailThread.count({ where: { AND: [{ id: threadId }, await this.access.threadWhere(ctx)] } })) > 0;
  }

  /** Which of these conversations / leads / contacts the caller may open (for links on tasks). */
  async readableIds(ctx: RequestContext, ids: { threads: string[]; leads: string[]; contacts: string[] }) {
    const [threads, leads, contacts] = await Promise.all([
      ids.threads.length && ctx.permissions['conversation.read']
        ? this.prisma.emailThread.findMany({ where: { AND: [{ id: { in: ids.threads } }, await this.access.threadWhere(ctx)] }, select: { id: true } })
        : [],
      ids.leads.length ? this.prisma.lead.findMany({ where: { AND: [{ id: { in: ids.leads } }, await this.leadWhere(ctx)] }, select: { id: true } }) : [],
      ids.contacts.length ? this.prisma.contact.findMany({ where: { AND: [{ id: { in: ids.contacts } }, await this.contactWhere(ctx)] }, select: { id: true } }) : [],
    ]);
    return { threads: new Set(threads.map((t) => t.id)), leads: new Set(leads.map((l) => l.id)), contacts: new Set(contacts.map((c) => c.id)) };
  }
}
