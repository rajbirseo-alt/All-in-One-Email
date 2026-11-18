import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '@crm/db';
import { newId } from '@crm/crypto';
import type { DraftView, Participant, ThreadChangedDetails } from '@crm/shared';
import type { z } from 'zod';
import type { createDraftSchema, sendDraftSchema, updateDraftSchema } from '@crm/shared';
import { AccessPolicy } from '../access/access-policy.service';
import { AuditService } from '../audit/audit.service';
import { ApiException, Errors } from '../common/errors';
import type { RequestContext } from '../common/request-context';
import { QueueService } from '../mail/queue.service';
import { PrismaService } from '../prisma/prisma.service';
import { sanitizeEmailHtml, textToHtml } from '../threads/email-html';

/** Per outgoing message (Gmail and Graph both cap around 25–35 MB including encoding). */
export const MAX_OUTGOING_ATTACHMENTS = 25 * 1024 * 1024;
/** Executable and script types are refused as attachments. */
const BLOCKED_EXT = /\.(exe|bat|cmd|com|scr|pif|msi|msp|js|jse|vbs|vbe|wsf|wsh|ps1|psm1|jar|lnk|reg|hta|cpl|dll|sys)$/i;

const draftInclude = {
  emailAccount: { select: { id: true, emailAddress: true, displayName: true, status: true } },
  attachments: { select: { id: true, filename: true, contentType: true, sizeBytes: true, isInline: true }, orderBy: { createdAt: 'asc' } },
} satisfies Prisma.DraftInclude;
type DraftRow = Prisma.DraftGetPayload<{ include: typeof draftInclude }>;

const people = (v: Prisma.JsonValue): Participant[] => (Array.isArray(v) ? (v as unknown as Participant[]) : []);
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmtAddr = (p: Participant) => (p.name ? `${esc(p.name)} &lt;${esc(p.address)}&gt;` : esc(p.address));

function dedupe(list: Participant[], exclude: Set<string>): Participant[] {
  const seen = new Set(exclude);
  const out: Participant[] = [];
  for (const p of list) {
    const a = p.address.toLowerCase();
    if (seen.has(a)) continue;
    seen.add(a);
    out.push({ address: a, name: p.name ?? null });
  }
  return out;
}

@Injectable()
export class DraftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessPolicy,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
  ) {}

  private toView(d: DraftRow): DraftView {
    return {
      id: d.id,
      mode: d.mode,
      source: d.source,
      status: d.status,
      emailAccount: { id: d.emailAccount.id, emailAddress: d.emailAccount.emailAddress, displayName: d.emailAccount.displayName },
      threadId: d.threadId,
      to: people(d.toRecipients),
      cc: people(d.ccRecipients),
      bcc: people(d.bccRecipients),
      subject: d.subject,
      bodyHtml: d.bodyHtml,
      baseThreadVersion: d.baseThreadVersion,
      attachments: d.attachments,
      scheduledFor: d.scheduledFor?.toISOString() ?? null,
      sendError: d.sendError,
      updatedAt: d.updatedAt.toISOString(),
    };
  }

  /** The caller's own draft; other people's drafts behave as non-existent. */
  private async own(ctx: RequestContext, id: string) {
    const d = await this.prisma.draft.findFirst({ where: { id, authorId: ctx.userId }, include: draftInclude });
    if (!d) throw Errors.notFound('Draft');
    return d;
  }

  private async signatureFor(userId: string, accountId: string) {
    const s = await this.prisma.signature.findFirst({
      where: { userId, isDefault: true, OR: [{ emailAccountId: accountId }, { emailAccountId: null }] },
      orderBy: { emailAccountId: { sort: 'asc', nulls: 'last' } },
    });
    return s ? `<div class="crm-signature">${sanitizeEmailHtml(s.html, { cidUrl: () => null, loadRemoteImages: true }).html}</div>` : '';
  }

  async create(ctx: RequestContext, input: z.infer<typeof createDraftSchema>): Promise<DraftView> {
    if (input.mode === 'NEW') {
      const account = await this.prisma.emailAccount.findUnique({ where: { id: input.emailAccountId! } });
      if (!account || account.status === 'DISCONNECTED') throw Errors.notFound('Mailbox');
      if (!(await this.access.canSendFrom(ctx, account.id))) throw Errors.forbidden('You cannot send from this mailbox');
      const id = newId();
      await this.prisma.draft.create({
        data: { id, emailAccountId: account.id, authorId: ctx.userId, mode: 'NEW', bodyHtml: `<p><br></p>${await this.signatureFor(ctx.userId, account.id)}` },
      });
      return this.toView(await this.own(ctx, id));
    }

    const thread = await this.prisma.emailThread.findFirst({
      where: { AND: [{ id: input.threadId! }, await this.access.threadWhere(ctx)] },
      include: { emailAccount: true },
    });
    if (!thread) throw Errors.notFound('Conversation');
    if (!(await this.access.canReply(ctx, thread))) throw Errors.forbidden('You cannot reply from this mailbox');
    const parent = input.messageId
      ? await this.prisma.emailMessage.findFirst({ where: { id: input.messageId, threadId: thread.id }, include: { attachments: true } })
      : await this.prisma.emailMessage.findFirst({ where: { threadId: thread.id }, orderBy: { receivedAt: 'desc' }, include: { attachments: true } });
    if (!parent) throw Errors.notFound('Message');

    const own = thread.emailAccount.emailAddress.toLowerCase();
    const from: Participant = { address: parent.fromAddress, name: parent.fromName };
    const pTo = people(parent.toRecipients);
    const pCc = people(parent.ccRecipients);
    const replyTo = people(parent.replyTo);
    let to: Participant[] = [];
    let cc: Participant[] = [];
    if (input.mode !== 'FORWARD') {
      const inbound = parent.direction === 'INBOUND';
      to = dedupe(inbound ? (replyTo.length ? replyTo : [from]) : pTo, new Set([own]));
      if (input.mode === 'REPLY_ALL') cc = dedupe(inbound ? [...pTo, ...pCc] : pCc, new Set([own, ...to.map((p) => p.address)]));
    }
    const base = parent.subject || thread.subject;
    const subject = input.mode === 'FORWARD' ? (/^fwd?:/i.test(base) ? base : `Fwd: ${base}`) : /^re:/i.test(base) ? base : `Re: ${base}`;

    const quoted = parent.bodyHtml ? sanitizeEmailHtml(parent.bodyHtml, { cidUrl: () => null, loadRemoteImages: true }).html : textToHtml(parent.bodyText ?? '');
    const when = (parent.sentAt ?? parent.receivedAt).toUTCString();
    const quote =
      input.mode === 'FORWARD'
        ? `<div class="crm-quote"><p>---------- Forwarded message ---------<br>From: ${fmtAddr(from)}<br>Date: ${esc(when)}<br>Subject: ${esc(parent.subject)}<br>To: ${pTo.map(fmtAddr).join(', ')}</p>${quoted}</div>`
        : `<div class="crm-quote"><p>On ${esc(when)}, ${fmtAddr(from)} wrote:</p><blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${quoted}</blockquote></div>`;

    const id = newId();
    await this.prisma.$transaction(async (tx) => {
      await tx.draft.create({
        data: {
          id,
          emailAccountId: thread.emailAccountId,
          threadId: thread.id,
          authorId: ctx.userId,
          mode: input.mode,
          inReplyToMessageId: parent.id,
          toRecipients: to as unknown as Prisma.InputJsonValue,
          ccRecipients: cc as unknown as Prisma.InputJsonValue,
          subject,
          bodyHtml: `<p><br></p>${await this.signatureFor(ctx.userId, thread.emailAccountId)}${quote}`,
          baseThreadVersion: thread.version,
        },
      });
      if (input.mode === 'FORWARD') {
        // Original attachments travel with a forward; their content is fetched at send time.
        const files = parent.attachments.filter((a) => !a.isInline);
        await tx.attachment.createMany({
          data: files.map((a) => ({ id: newId(), draftId: id, sourceAttachmentId: a.id, filename: a.filename, contentType: a.contentType, sizeBytes: a.sizeBytes, isInline: false })),
        });
      }
    });
    return this.toView(await this.own(ctx, id));
  }

  async list(ctx: RequestContext, threadId?: string): Promise<DraftView[]> {
    const rows = await this.prisma.draft.findMany({
      where: { authorId: ctx.userId, status: { in: ['EDITING', 'FAILED', 'QUEUED'] }, ...(threadId ? { threadId } : {}) },
      include: draftInclude,
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });
    return rows.map((d) => this.toView(d));
  }

  async get(ctx: RequestContext, id: string) {
    return this.toView(await this.own(ctx, id));
  }

  private editable(d: DraftRow) {
    if (d.status !== 'EDITING' && d.status !== 'FAILED') throw Errors.conflict('This draft is being sent or was sent', 'DRAFT_LOCKED');
  }

  async update(ctx: RequestContext, id: string, patch: z.infer<typeof updateDraftSchema>) {
    const d = await this.own(ctx, id);
    this.editable(d);
    const json = (v: unknown) => v as Prisma.InputJsonValue;
    await this.prisma.draft.update({
      where: { id },
      data: {
        ...(patch.to ? { toRecipients: json(patch.to) } : {}),
        ...(patch.cc ? { ccRecipients: json(patch.cc) } : {}),
        ...(patch.bcc ? { bccRecipients: json(patch.bcc) } : {}),
        ...(patch.subject !== undefined ? { subject: patch.subject } : {}),
        // Sanitised on save: the composer renders this HTML in the CRM page itself.
        ...(patch.bodyHtml !== undefined ? { bodyHtml: sanitizeEmailHtml(patch.bodyHtml, { cidUrl: () => null, loadRemoteImages: true }).html } : {}),
        status: 'EDITING',
        sendError: null,
      },
    });
    return this.get(ctx, id);
  }

  async remove(ctx: RequestContext, id: string) {
    const d = await this.own(ctx, id);
    this.editable(d);
    await this.prisma.draft.delete({ where: { id } });
  }

  async addAttachment(ctx: RequestContext, id: string, file: { originalname: string; mimetype: string; buffer: Buffer }) {
    const d = await this.own(ctx, id);
    this.editable(d);
    const name = file.originalname.replace(/[\\/\r\n]/g, '_').slice(0, 255) || 'attachment';
    if (BLOCKED_EXT.test(name)) throw Errors.validation([{ path: 'file', message: 'Executable files cannot be attached' }]);
    const total = d.attachments.reduce((n, a) => n + a.sizeBytes, 0) + file.buffer.length;
    if (total > MAX_OUTGOING_ATTACHMENTS) throw Errors.validation([{ path: 'file', message: 'Attachments may total at most 25 MB per email' }]);
    await this.prisma.attachment.create({
      data: {
        id: newId(),
        draftId: id,
        filename: name,
        contentType: (file.mimetype || 'application/octet-stream').slice(0, 200),
        sizeBytes: file.buffer.length,
        content: new Uint8Array(file.buffer),
        sha256: createHash('sha256').update(file.buffer).digest('hex'),
      },
    });
    return this.get(ctx, id);
  }

  async removeAttachment(ctx: RequestContext, id: string, attachmentId: string) {
    const d = await this.own(ctx, id);
    this.editable(d);
    await this.prisma.attachment.deleteMany({ where: { id: attachmentId, draftId: id } });
    return this.get(ctx, id);
  }

  /**
   * The explicit human send. Re-checks permission, refuses when new mail arrived in the thread
   * since the author's base version (409 THREAD_CHANGED), then queues the send.
   * This is the ONLY path that sends: AI or automation drafts must come through here too.
   */
  async send(ctx: RequestContext, id: string, input: z.infer<typeof sendDraftSchema>) {
    const d = await this.own(ctx, id);
    this.editable(d);
    const to = people(d.toRecipients);
    const cc = people(d.ccRecipients);
    const bcc = people(d.bccRecipients);
    if (!to.length && !cc.length && !bcc.length) throw Errors.validation([{ path: 'to', message: 'Add at least one recipient' }]);
    if (['DISCONNECTED', 'NEEDS_REAUTH', 'PAUSED'].includes(d.emailAccount.status)) {
      throw Errors.conflict('This mailbox is not connected; ask an administrator to reconnect it', 'MAILBOX_INACTIVE');
    }
    if (input.scheduledFor && input.scheduledFor.getTime() < Date.now() - 60_000) throw Errors.validation([{ path: 'scheduledFor', message: 'Choose a time in the future' }]);

    if (d.threadId) {
      const thread = await this.prisma.emailThread.findUnique({ where: { id: d.threadId } });
      if (!thread || !(await this.access.canReply(ctx, thread))) throw Errors.forbidden('You cannot reply from this mailbox');
      const base = input.baseThreadVersion ?? d.baseThreadVersion;
      if (base !== null && base !== undefined && thread.version !== base) {
        const newMessages = await this.prisma.emailMessage.findMany({
          where: { threadId: thread.id, createdAt: { gt: d.createdAt } },
          orderBy: { receivedAt: 'asc' },
          select: { id: true, fromAddress: true, fromName: true, subject: true, snippet: true, receivedAt: true },
        });
        const details: ThreadChangedDetails = {
          currentVersion: thread.version,
          newMessages: newMessages.map((m) => ({ id: m.id, from: { address: m.fromAddress, name: m.fromName }, subject: m.subject, snippet: m.snippet, receivedAt: m.receivedAt.toISOString() })),
        };
        throw new ApiException(409, 'THREAD_CHANGED', 'New messages arrived in this conversation while you were writing', details);
      }
    } else if (!(await this.access.canSendFrom(ctx, d.emailAccountId))) {
      throw Errors.forbidden('You cannot send from this mailbox');
    }

    const approvedAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      const n = await tx.draft.updateMany({
        where: { id, status: { in: ['EDITING', 'FAILED'] } },
        data: { status: 'QUEUED', approvedById: ctx.userId, approvedAt, idempotencyKey: id, scheduledFor: input.scheduledFor ?? null, sendError: null },
      });
      if (n.count !== 1) throw Errors.conflict('This draft is already being sent', 'DRAFT_LOCKED');
      // IDs and counts only: message bodies never go into the audit log.
      await this.audit.record(tx, ctx, {
        action: 'message.send',
        entityType: 'Draft',
        entityId: id,
        metadata: { threadId: d.threadId, emailAccountId: d.emailAccountId, mode: d.mode, source: d.source, recipients: to.length + cc.length + bcc.length, attachments: d.attachments.length, scheduledFor: input.scheduledFor ?? null },
      });
    });
    await this.queue.enqueueSend({ draftId: id, approvedAt: approvedAt.toISOString() }, input.scheduledFor ?? undefined);
    return { status: 'QUEUED' as const, scheduledFor: input.scheduledFor?.toISOString() ?? null };
  }

  /** Cancels a scheduled send that has not started yet; the draft becomes editable again. */
  async cancelSend(ctx: RequestContext, id: string) {
    const d = await this.own(ctx, id);
    const n = await this.prisma.draft.updateMany({ where: { id: d.id, status: 'QUEUED' }, data: { status: 'EDITING', approvedById: null, approvedAt: null, idempotencyKey: null } });
    if (n.count !== 1) throw Errors.conflict('This draft is not waiting to be sent', 'NOT_QUEUED');
    await this.prisma.$transaction((tx) => this.audit.record(tx, ctx, { action: 'message.send_cancel', entityType: 'Draft', entityId: id }));
    return this.get(ctx, id);
  }
}
