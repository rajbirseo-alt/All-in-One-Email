import { Injectable } from '@nestjs/common';
import type { Prisma } from '@crm/db';
import { newId } from '@crm/crypto';
import type { SignatureView, TemplateView } from '@crm/shared';
import type { z } from 'zod';
import type { signatureSchema, templateSchema } from '@crm/shared';
import { AccessPolicy } from '../access/access-policy.service';
import { Errors } from '../common/errors';
import type { RequestContext } from '../common/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { sanitizeEmailHtml } from '../threads/email-html';

/** Signatures and template bodies go into outgoing mail: sanitise them on save. */
const clean = (html: string) => sanitizeEmailHtml(html, { cidUrl: () => null, loadRemoteImages: true }).html;

@Injectable()
export class SignaturesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessPolicy,
  ) {}

  async list(ctx: RequestContext): Promise<SignatureView[]> {
    const rows = await this.prisma.signature.findMany({ where: { userId: ctx.userId }, orderBy: { name: 'asc' } });
    return rows.map((s) => ({ id: s.id, name: s.name, html: s.html, emailAccountId: s.emailAccountId, isDefault: s.isDefault }));
  }

  async save(ctx: RequestContext, id: string | null, input: z.infer<typeof signatureSchema>) {
    if (id && !(await this.prisma.signature.count({ where: { id, userId: ctx.userId } }))) throw Errors.notFound('Signature');
    if (input.emailAccountId && !(await this.access.canSendFrom(ctx, input.emailAccountId))) {
      throw Errors.validation([{ path: 'emailAccountId', message: 'You cannot send from this mailbox' }]);
    }
    const data = { name: input.name, html: clean(input.html), emailAccountId: input.emailAccountId ?? null, isDefault: input.isDefault };
    const sigId = id ?? newId();
    await this.prisma.$transaction(async (tx) => {
      // One default per mailbox (or for "all mailboxes").
      if (input.isDefault) {
        await tx.signature.updateMany({ where: { userId: ctx.userId, emailAccountId: data.emailAccountId, NOT: { id: sigId } }, data: { isDefault: false } });
      }
      if (id) await tx.signature.update({ where: { id }, data });
      else await tx.signature.create({ data: { id: sigId, userId: ctx.userId, ...data } });
    });
    return (await this.list(ctx)).find((s) => s.id === sigId)!;
  }

  async remove(ctx: RequestContext, id: string) {
    const n = await this.prisma.signature.deleteMany({ where: { id, userId: ctx.userId } });
    if (!n.count) throw Errors.notFound('Signature');
  }
}

@Injectable()
export class TemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessPolicy,
  ) {}

  /** Mine, my departments' shared ones, and company-wide ones. */
  private async visibleWhere(ctx: RequestContext): Promise<Prisma.TemplateWhereInput> {
    const depts = await this.access.departmentIds(ctx);
    return { OR: [{ ownerId: ctx.userId }, { isShared: true, departmentId: null }, { isShared: true, departmentId: { in: depts } }] };
  }

  private canManageCompanyWide(ctx: RequestContext) {
    return ctx.permissions['conversation.read'] === 'ALL';
  }

  async list(ctx: RequestContext): Promise<TemplateView[]> {
    const rows = await this.prisma.template.findMany({ where: await this.visibleWhere(ctx), include: { owner: { select: { id: true, name: true } } }, orderBy: { name: 'asc' } });
    return rows.map((t) => {
      const sharing = !t.isShared ? 'private' : t.departmentId ? 'department' : 'company';
      return {
        id: t.id,
        name: t.name,
        subject: t.subject,
        bodyHtml: t.bodyHtml,
        sharing,
        owner: t.owner,
        canEdit: t.ownerId === ctx.userId || (sharing === 'company' && this.canManageCompanyWide(ctx)),
      };
    });
  }

  async save(ctx: RequestContext, id: string | null, input: z.infer<typeof templateSchema>) {
    if (id) {
      const t = (await this.list(ctx)).find((x) => x.id === id);
      if (!t) throw Errors.notFound('Template');
      if (!t.canEdit) throw Errors.forbidden();
    }
    if (input.sharing === 'company' && !this.canManageCompanyWide(ctx)) throw Errors.forbidden('Only administrators can share templates company-wide');
    if (input.sharing === 'department' && !ctx.departmentId) throw Errors.validation([{ path: 'sharing', message: 'You are not in a department' }]);
    const data = {
      name: input.name,
      subject: input.subject ?? null,
      bodyHtml: clean(input.bodyHtml),
      isShared: input.sharing !== 'private',
      departmentId: input.sharing === 'department' ? ctx.departmentId : null,
    };
    const tid = id ?? newId();
    if (id) await this.prisma.template.update({ where: { id }, data });
    else await this.prisma.template.create({ data: { id: tid, ownerId: ctx.userId, ...data } });
    return (await this.list(ctx)).find((t) => t.id === tid)!;
  }

  async remove(ctx: RequestContext, id: string) {
    const t = (await this.list(ctx)).find((x) => x.id === id);
    if (!t) throw Errors.notFound('Template');
    if (!t.canEdit) throw Errors.forbidden();
    await this.prisma.template.delete({ where: { id } });
  }
}
