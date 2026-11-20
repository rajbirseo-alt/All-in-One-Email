import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@crm/db';
import { newId } from '@crm/crypto';
import { AuthError, ProviderRequestError, RateLimitedError, TransientError, imapMessageKey, smtpSend } from '@crm/providers';
import type { Participant } from '@crm/shared';
import { CredentialService } from '../mail/credential.service';
import { IngestService } from '../mail/ingest.service';
import { MAIL_ENDPOINTS, type MailEndpoints } from '../mail/mail-endpoints';
import type { SendJob } from '../mail/queue.service';
import { SyncService } from '../mail/sync.service';
import { PrismaService } from '../prisma/prisma.service';
import { AttachmentsService } from '../threads/attachments.service';
import { buildMime, htmlToText } from './mime';

const people = (v: Prisma.JsonValue): Participant[] => (Array.isArray(v) ? (v as unknown as Participant[]) : []);

interface Sent {
  providerMessageId: string;
  providerThreadId: string | null;
  internetMessageId: string;
}

/**
 * Worker: sends one human-approved draft. Safe against double sending:
 *  - the draft moves QUEUED → SENDING atomically, so only one job can send it;
 *  - on a retry after an ambiguous failure, Gmail is searched for our Message-ID and the Graph
 *    draft is inspected before anything is sent again.
 */
@Injectable()
export class SendService {
  private readonly log = new Logger(SendService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sync: SyncService,
    private readonly ingest: IngestService,
    private readonly attachments: AttachmentsService,
    private readonly credentials: CredentialService,
    @Inject(MAIL_ENDPOINTS) private readonly endpoints: MailEndpoints,
  ) {}

  async send(job: SendJob): Promise<'sent' | 'skipped' | 'failed'> {
    const claimed = await this.prisma.draft.updateMany({
      where: { id: job.draftId, status: 'QUEUED', approvedAt: new Date(job.approvedAt) },
      data: { status: 'SENDING' },
    });
    if (claimed.count !== 1) return 'skipped'; // cancelled, re-approved later, or already handled

    const draft = await this.prisma.draft.findUniqueOrThrow({
      where: { id: job.draftId },
      include: { emailAccount: true, attachments: true, thread: true },
    });
    try {
      const provider = draft.emailAccount.provider;
      const sent = provider === 'GMAIL' ? await this.viaGmail(draft) : provider === 'MICROSOFT' ? await this.viaGraph(draft) : await this.viaImap(draft);
      await this.record(draft, sent);
      return 'sent';
    } catch (e) {
      const retry = e instanceof TransientError || e instanceof RateLimitedError;
      const message =
        e instanceof AuthError ? 'The mailbox needs to be reconnected before mail can be sent.' : e instanceof ProviderRequestError ? `The provider rejected the message: ${e.message}` : (e as Error).message;
      await this.prisma.draft.update({
        where: { id: draft.id },
        // Retryable: back to QUEUED for the next attempt. Otherwise FAILED, editable again.
        data: retry ? { status: 'QUEUED', sendError: message.slice(0, 1000) } : { status: 'FAILED', sendError: message.slice(0, 1000) },
      });
      await this.prisma.syncLog.create({
        data: { id: newId(), emailAccountId: draft.emailAccountId, kind: 'SEND', status: 'FAILED', error: message.slice(0, 1000), details: { draftId: draft.id, retry }, finishedAt: new Date() },
      });
      if (retry) throw e;
      return 'failed';
    }
  }

  private async parentOf(draft: { inReplyToMessageId: string | null }) {
    return draft.inReplyToMessageId ? this.prisma.emailMessage.findUnique({ where: { id: draft.inReplyToMessageId } }) : null;
  }

  private async files(draft: { attachments: { filename: string; contentType: string; content: Uint8Array | null; sourceAttachmentId: string | null }[] }, includeForwarded: boolean) {
    const out: { filename: string; contentType: string; content: Buffer }[] = [];
    for (const a of draft.attachments) {
      if (a.content) out.push({ filename: a.filename, contentType: a.contentType, content: Buffer.from(a.content) });
      else if (a.sourceAttachmentId && includeForwarded) out.push({ filename: a.filename, contentType: a.contentType, content: await this.attachments.receivedContent(a.sourceAttachmentId) });
    }
    return out;
  }

  private async viaGmail(draft: Prisma.DraftGetPayload<{ include: { emailAccount: true; attachments: true; thread: true } }>): Promise<Sent> {
    const gmail = this.sync.gmail(draft.emailAccountId);
    const domain = draft.emailAccount.emailAddress.split('@')[1] ?? 'mail.local';
    let messageId = draft.messageIdHeader;
    if (messageId) {
      // A previous attempt may have reached Gmail before failing: never send twice.
      const existing = await gmail.findByMessageId(messageId);
      if (existing.length) return { providerMessageId: existing[0]!, providerThreadId: draft.thread?.providerThreadId ?? null, internetMessageId: messageId };
    } else {
      messageId = `<${randomUUID()}@${domain}>`;
      await this.prisma.draft.update({ where: { id: draft.id }, data: { messageIdHeader: messageId } });
    }
    const parent = await this.parentOf(draft);
    const mime = await buildMime({
      from: { address: draft.emailAccount.emailAddress, name: draft.emailAccount.displayName },
      to: people(draft.toRecipients),
      cc: people(draft.ccRecipients),
      bcc: people(draft.bccRecipients),
      subject: draft.subject,
      html: draft.bodyHtml,
      messageId,
      inReplyTo: draft.mode === 'FORWARD' ? null : (parent?.internetMessageId ?? null),
      references: draft.mode === 'FORWARD' || !parent ? [] : [...parent.references, ...(parent.internetMessageId ? [parent.internetMessageId] : [])].slice(-20),
      attachments: await this.files(draft, true),
    });
    // Gmail keeps the conversation only with the threadId AND matching headers/subject.
    const res = await gmail.send(mime, draft.mode === 'NEW' ? null : (draft.thread?.providerThreadId ?? null));
    return { providerMessageId: res.id, providerThreadId: res.threadId, internetMessageId: messageId };
  }

  private async viaGraph(draft: Prisma.DraftGetPayload<{ include: { emailAccount: true; attachments: true; thread: true } }>): Promise<Sent> {
    const graph = this.sync.graph(draft.emailAccountId);
    if (draft.providerDraftId) {
      const meta = await graph.messageMeta(draft.providerDraftId);
      if (meta && !meta.isDraft) {
        // Already sent by a previous attempt (immutable id now points at the copy in Sent Items).
        return { providerMessageId: draft.providerDraftId, providerThreadId: meta.conversationId, internetMessageId: meta.internetMessageId ?? '' };
      }
      // Half-built draft from a failed attempt: start over to avoid duplicate attachments.
      if (meta) await graph.deleteMessage(draft.providerDraftId);
    }
    const parent = await this.parentOf(draft);
    const kind = draft.mode === 'NEW' || !parent ? 'new' : draft.mode === 'REPLY' ? 'reply' : draft.mode === 'REPLY_ALL' ? 'replyAll' : 'forward';
    const draftId = await graph.createDraft(parent?.providerMessageId ?? null, kind);
    await this.prisma.draft.update({ where: { id: draft.id }, data: { providerDraftId: draftId } });
    await graph.updateDraft(draftId, {
      subject: draft.subject,
      html: draft.bodyHtml,
      to: people(draft.toRecipients),
      cc: people(draft.ccRecipients),
      bcc: people(draft.bccRecipients),
    });
    // createForward already carries the original attachments; only uploads are added.
    for (const f of await this.files(draft, kind !== 'forward')) await graph.addAttachment(draftId, { name: f.filename, contentType: f.contentType, data: f.content });
    await graph.sendDraft(draftId);
    const meta = await graph.messageMeta(draftId);
    return { providerMessageId: draftId, providerThreadId: meta?.conversationId ?? null, internetMessageId: meta?.internetMessageId ?? '' };
  }

  /** Marker in `providerDraftId`: the SMTP server accepted this Message-ID, so a retry must not send again. */
  private static readonly SMTP_ACCEPTED = 'smtp-accepted:';

  /**
   * SMTP, then a copy in the Sent folder (IMAP APPEND) unless the server filed one itself.
   * Retries never send twice: once SMTP accepts, the draft is marked; a retry only finishes the
   * Sent copy. Bcc recipients get the mail through the SMTP envelope; the Bcc header is only in
   * the Sent copy.
   */
  private async viaImap(draft: Prisma.DraftGetPayload<{ include: { emailAccount: true; attachments: true; thread: true } }>): Promise<Sent> {
    const cfg = await this.credentials.imapConfig(draft.emailAccountId);
    const imap = await this.credentials.imap(draft.emailAccountId);
    const domain = draft.emailAccount.emailAddress.split('@')[1] ?? 'mail.local';
    let messageId = draft.messageIdHeader;
    if (!messageId) {
      messageId = `<${randomUUID()}@${domain}>`;
      await this.prisma.draft.update({ where: { id: draft.id }, data: { messageIdHeader: messageId } });
    }
    const parent = await this.parentOf(draft);
    const to = people(draft.toRecipients);
    const cc = people(draft.ccRecipients);
    const bcc = people(draft.bccRecipients);
    const mail = {
      from: { address: draft.emailAccount.emailAddress, name: draft.emailAccount.displayName },
      to,
      cc,
      subject: draft.subject,
      html: draft.bodyHtml,
      messageId,
      inReplyTo: draft.mode === 'FORWARD' ? null : (parent?.internetMessageId ?? null),
      references: draft.mode === 'FORWARD' || !parent ? [] : [...parent.references, ...(parent.internetMessageId ? [parent.internetMessageId] : [])].slice(-20),
      attachments: await this.files(draft, true),
    };
    const sentFolder = await this.prisma.emailFolder.findFirst({ where: { emailAccountId: draft.emailAccountId, type: 'SENT' } });
    try {
      if (draft.providerDraftId !== SendService.SMTP_ACCEPTED + messageId) {
        const recipients = [...to, ...cc, ...bcc].map((r) => r.address);
        await smtpSend(cfg, await buildMime({ ...mail, bcc: [] }), { from: draft.emailAccount.emailAddress, to: recipients }, this.endpoints.imap);
        await this.prisma.draft.update({ where: { id: draft.id }, data: { providerDraftId: SendService.SMTP_ACCEPTED + messageId } });
      }
      if (sentFolder) {
        try {
          // Some servers (Gmail, Microsoft, some Zoho plans) file the copy themselves.
          const already = await imap.findByMessageId(sentFolder.providerFolderId, messageId);
          if (!already.length) await imap.append(sentFolder.providerFolderId, await buildMime({ ...mail, bcc }), ['\\Seen']);
        } catch (e) {
          // The mail is sent; only the provider-side copy is missing. The CRM keeps its own copy.
          this.log.warn(`Sent copy of draft ${draft.id} could not be saved in ${sentFolder.providerFolderId}: ${(e as Error).message}`);
        }
      }
    } finally {
      await imap.close();
    }
    return { providerMessageId: imapMessageKey(messageId, sentFolder?.providerFolderId ?? 'Sent', 0, 0), providerThreadId: null, internetMessageId: messageId };
  }

  /** Stores the sent message in its conversation right away; the next sync dedupes the provider's copy. */
  private async record(draft: Prisma.DraftGetPayload<{ include: { emailAccount: true; attachments: true; thread: true } }>, sent: Sent) {
    const sentFolder = await this.prisma.emailFolder.findFirst({ where: { emailAccountId: draft.emailAccountId, type: 'SENT' } });
    const now = new Date();
    let threadId = draft.threadId;
    if (!threadId || (sent.providerThreadId && draft.thread?.providerThreadId && draft.thread.providerThreadId !== sent.providerThreadId)) {
      const t = sent.providerThreadId
        ? await this.prisma.emailThread.upsert({
            where: { emailAccountId_providerThreadId: { emailAccountId: draft.emailAccountId, providerThreadId: sent.providerThreadId } },
            create: { id: newId(), emailAccountId: draft.emailAccountId, providerThreadId: sent.providerThreadId, subject: draft.subject || '(no subject)', normalizedSubject: draft.subject.toLowerCase(), firstMessageAt: now, lastMessageAt: now },
            update: {},
          })
        : await this.prisma.emailThread.create({ data: { id: newId(), emailAccountId: draft.emailAccountId, subject: draft.subject || '(no subject)', normalizedSubject: draft.subject.toLowerCase(), firstMessageAt: now, lastMessageAt: now } });
      threadId = t.id;
    }
    const parent = await this.parentOf(draft);
    const id = newId();
    try {
      await this.prisma.$transaction([
        this.prisma.emailMessage.create({
          data: {
            id,
            threadId,
            emailAccountId: draft.emailAccountId,
            providerMessageId: sent.providerMessageId,
            internetMessageId: sent.internetMessageId || null,
            inReplyTo: draft.mode === 'FORWARD' ? null : (parent?.internetMessageId ?? null),
            references: parent?.internetMessageId && draft.mode !== 'FORWARD' ? [...parent.references, parent.internetMessageId] : [],
            direction: 'OUTBOUND',
            fromAddress: draft.emailAccount.emailAddress,
            fromName: draft.emailAccount.displayName,
            toRecipients: draft.toRecipients as Prisma.InputJsonValue,
            ccRecipients: draft.ccRecipients as Prisma.InputJsonValue,
            bccRecipients: draft.bccRecipients as Prisma.InputJsonValue,
            subject: draft.subject,
            snippet: htmlToText(draft.bodyHtml).slice(0, 200),
            bodyHtml: draft.bodyHtml,
            bodyText: htmlToText(draft.bodyHtml),
            hasAttachments: draft.attachments.length > 0,
            isRead: true,
            sentAt: now,
            receivedAt: now,
            sentByUserId: draft.approvedById,
          },
        }),
        this.prisma.attachment.createMany({
          data: draft.attachments.map((a) => ({ id: newId(), messageId: id, filename: a.filename, contentType: a.contentType, sizeBytes: a.sizeBytes, sha256: a.sha256 })),
        }),
        ...(sentFolder ? [this.prisma.messageFolder.create({ data: { messageId: id, folderId: sentFolder.id } })] : []),
      ]);
    } catch (e) {
      // The sync already stored the provider's copy: keep it and record who sent it.
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
      await this.prisma.emailMessage.updateMany({
        where: { emailAccountId: draft.emailAccountId, providerMessageId: sent.providerMessageId },
        data: { sentByUserId: draft.approvedById },
      });
    }
    const stored = await this.prisma.emailMessage.findFirstOrThrow({ where: { emailAccountId: draft.emailAccountId, providerMessageId: sent.providerMessageId } });
    await this.prisma.$transaction([
      this.prisma.draft.update({ where: { id: draft.id }, data: { status: 'SENT', sentMessageId: stored.id, sendError: null, threadId: stored.threadId } }),
      // Uploaded bytes are no longer needed once the provider has the message.
      this.prisma.attachment.updateMany({ where: { draftId: draft.id }, data: { content: null } }),
      this.prisma.syncLog.create({ data: { id: newId(), emailAccountId: draft.emailAccountId, kind: 'SEND', status: 'SUCCEEDED', messagesAdded: 1, details: { draftId: draft.id }, finishedAt: new Date() } }),
    ]);
    await this.ingest.refreshThreads([stored.threadId]);
    this.log.log(`Sent draft ${draft.id} as ${sent.providerMessageId}`);
  }
}
