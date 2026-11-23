import { HttpStatus, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AccessPolicy } from '../access/access-policy.service';
import { ApiException, Errors } from '../common/errors';
import type { RequestContext } from '../common/request-context';
import { attachmentFromSource } from '@crm/providers';
import { CredentialService } from '../mail/credential.service';
import { SyncService } from '../mail/sync.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { FileStore } from '../storage/file-store.service';

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
 * Received attachment content is fetched from the provider on first use, after the same
 * conversation access check as the message itself, and virus-scanned before anyone gets it.
 * With object storage configured, the (encrypted) content is kept for later downloads.
 */
@Injectable()
export class AttachmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessPolicy,
    private readonly sync: SyncService,
    private readonly credentials: CredentialService,
    private readonly files: FileStore,
    private readonly audit: AuditService,
  ) {}

  async download(ctx: RequestContext, id: string, wantInline: boolean): Promise<AttachmentDownload> {
    const visible = await this.prisma.attachment.count({ where: { id, message: { thread: await this.access.threadWhere(ctx) } } });
    if (!visible) throw Errors.notFound('Attachment');
    const att = await this.prisma.attachment.findUniqueOrThrow({ where: { id } });
    const data = await this.cleanReceived(id, ctx);
    return { filename: att.filename, contentType: att.contentType, inline: wantInline && INLINE_SAFE.has(att.contentType.toLowerCase()), data };
  }

  /**
   * Content of a RECEIVED attachment that passed the virus scan: from object storage when kept
   * there, else from the provider (then scanned, and kept if storage is configured). An infected
   * file is refused (422 MALWARE) now and on every later attempt. No access check: callers check
   * first (download) or act on a human-approved send (forwarding).
   */
  async cleanReceived(id: string, actor: RequestContext | null = null): Promise<Buffer> {
    const att = await this.prisma.attachment.findUnique({ where: { id } });
    if (!att?.messageId) throw Errors.notFound('Attachment');
    if (att.scanStatus === 'INFECTED') throw this.blocked(att.filename);
    let data = att.storageKey ? await this.files.get(att.id, att.storageKey) : null;
    const cached = !!data;
    data ??= await this.receivedContent(id);
    let status = att.scanStatus;
    if (status !== 'CLEAN' && (status !== 'SKIPPED' || this.files.scanning)) {
      const r = await this.files.scan(data);
      if (r.status === 'INFECTED') {
        await this.prisma.attachment.updateMany({ where: { id }, data: { scanStatus: 'INFECTED' } });
        await this.audit.record(this.prisma, actor ?? { userId: null, actorType: 'SYSTEM' }, {
          action: 'attachment.blocked',
          entityType: 'Attachment',
          entityId: id,
          metadata: { filename: att.filename, signature: r.signature },
        });
        throw this.blocked(att.filename, r.signature);
      }
      if (r.status === 'FAILED') throw this.files.unavailable(r.error);
      status = r.status === 'CLEAN' ? 'CLEAN' : 'SKIPPED';
    }
    const update: { scanStatus?: typeof status; storageKey?: string } = {};
    if (status !== att.scanStatus) update.scanStatus = status;
    if (!cached && this.files.storing) update.storageKey = await this.files.put(att.id, data);
    if (Object.keys(update).length) await this.prisma.attachment.updateMany({ where: { id }, data: update });
    return data;
  }

  private blocked(filename: string, signature?: string) {
    return new ApiException(HttpStatus.UNPROCESSABLE_ENTITY, 'MALWARE', `"${filename}" contains malware${signature ? ` (${signature})` : ''} and was blocked`);
  }

  /** Deletes stored files (best effort). */
  removeStored(keys: (string | null)[]) {
    return this.files.remove(keys);
  }

  /** Bytes of a file uploaded to a draft (database or object storage). */
  async draftContent(a: { id: string; content: Uint8Array | null; storageKey: string | null }): Promise<Buffer | null> {
    if (a.content) return Buffer.from(a.content);
    if (a.storageKey) return this.files.get(a.id, a.storageKey);
    return null;
  }

  /** Content of a received attachment straight from the provider (no scan; use cleanReceived). */
  private async receivedContent(id: string): Promise<Buffer> {
    const att = await this.prisma.attachment.findUnique({
      where: { id },
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
      // IMAP: download the message from one of its folders and take the part out of it.
      data = null;
      const links = await this.prisma.messageFolder.findMany({ where: { messageId: message.id, imapUid: { not: null } }, select: { imapUid: true, folder: { select: { providerFolderId: true } } } });
      if (links.length) {
        const imap = await this.credentials.imap(message.emailAccountId);
        try {
          for (const l of links) {
            const source = await imap.source(l.folder.providerFolderId, Number(l.imapUid));
            if (source) {
              data = await attachmentFromSource(source, att.providerAttachmentId);
              break;
            }
          }
        } finally {
          await imap.close();
        }
      }
    }
    if (!data) throw Errors.notFound('Attachment');
    if (!att.sha256) {
      await this.prisma.attachment.update({ where: { id }, data: { sha256: createHash('sha256').update(data).digest('hex') } });
    }
    return data;
  }
}
