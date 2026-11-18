import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AccessPolicy } from '../access/access-policy.service';
import { Errors } from '../common/errors';
import type { RequestContext } from '../common/request-context';
import { SyncService } from '../mail/sync.service';
import { PrismaService } from '../prisma/prisma.service';

/** Inbound attachments larger than this are not proxied (provider limits are 25 MB per message). */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** Only these may be shown inline (e.g. images in the message body); everything else downloads. */
const INLINE_SAFE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export interface AttachmentDownload {
  filename: string;
  contentType: string;
  inline: boolean;
  data: Buffer;
}

/**
 * Inbound attachment content is fetched from the provider on demand (not stored), after the same
 * conversation access check as the message itself.
 */
@Injectable()
export class AttachmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessPolicy,
    private readonly sync: SyncService,
  ) {}

  async download(ctx: RequestContext, id: string, wantInline: boolean): Promise<AttachmentDownload> {
    const att = await this.prisma.attachment.findFirst({
      where: { id, message: { thread: await this.access.threadWhere(ctx) } },
      include: { message: { include: { emailAccount: { select: { id: true, provider: true, status: true } } } } },
    });
    if (!att?.message) throw Errors.notFound('Attachment');
    const { message } = att;
    if (att.sizeBytes > MAX_ATTACHMENT_BYTES) throw Errors.badRequest('This attachment is too large to download through the CRM', 'TOO_LARGE');
    if (['DISCONNECTED', 'NEEDS_REAUTH', 'PAUSED'].includes(message.emailAccount.status)) {
      throw Errors.conflict('The mailbox must be connected to download attachments', 'MAILBOX_INACTIVE');
    }
    if (!att.providerAttachmentId) throw Errors.notFound('Attachment');

    let data: Buffer | null;
    if (message.emailAccount.provider === 'GMAIL') {
      const gmail = this.sync.gmail(message.emailAccountId);
      data = await gmail.attachment(message.providerMessageId, att.providerAttachmentId);
      if (!data) {
        // Gmail attachment ids are not stable across fetches: look the part up again by name and size.
        const fresh = await gmail.getMessage(message.providerMessageId);
        const match = fresh?.attachments.find((a) => a.filename === att.filename && a.sizeBytes === att.sizeBytes && a.providerAttachmentId);
        if (match) {
          data = await gmail.attachment(message.providerMessageId, match.providerAttachmentId!);
          await this.prisma.attachment.update({ where: { id }, data: { providerAttachmentId: match.providerAttachmentId } });
        }
      }
    } else if (message.emailAccount.provider === 'MICROSOFT') {
      data = await this.sync.graph(message.emailAccountId).attachmentContent(message.providerMessageId, att.providerAttachmentId);
    } else {
      data = null;
    }
    if (!data) throw Errors.notFound('Attachment');
    if (!att.sha256) {
      await this.prisma.attachment.update({ where: { id }, data: { sha256: createHash('sha256').update(data).digest('hex') } });
    }
    return { filename: att.filename, contentType: att.contentType, inline: wantInline && INLINE_SAFE.has(att.contentType.toLowerCase()), data };
  }
}
