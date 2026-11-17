import { Injectable } from '@nestjs/common';
import { Prisma, type FolderType } from '@crm/db';
import { newId } from '@crm/crypto';
import { normalizeSubject, type NormalizedMessage } from '@crm/providers';
import { PrismaService } from '../prisma/prisma.service';

export interface FolderRef {
  id: string;
  type: FolderType;
}

export interface IngestTarget {
  accountId: string;
  /** The mailbox's own address: mail from it is outbound. */
  accountEmail: string;
  /** providerFolderId → stored folder. Messages are linked only to known folders. */
  folders: Map<string, FolderRef>;
}

export interface IngestResult {
  added: number;
  updated: number;
  removed: number;
  threadIds: Set<string>;
}

const json = (v: unknown) => v as Prisma.InputJsonValue;

/**
 * Provider-independent ingestion: dedupe → thread → persist. Idempotent: the same message
 * ingested twice updates the existing row (unique accountId + providerMessageId).
 */
@Injectable()
export class IngestService {
  constructor(private readonly prisma: PrismaService) {}

  emptyResult(): IngestResult {
    return { added: 0, updated: 0, removed: 0, threadIds: new Set() };
  }

  async ingest(target: IngestTarget, messages: NormalizedMessage[], result: IngestResult = this.emptyResult()): Promise<IngestResult> {
    for (const m of messages) {
      // Provider drafts are not conversations; CRM drafts live in their own table (Phase 3).
      if (m.isDraft) {
        result.removed += await this.removeMessages(target.accountId, [m.providerMessageId], result.threadIds);
        continue;
      }
      const folderLinks = m.providerFolderIds.map((id) => target.folders.get(id)).filter((f): f is FolderRef => !!f);
      const existing = await this.prisma.emailMessage.findUnique({
        where: { emailAccountId_providerMessageId: { emailAccountId: target.accountId, providerMessageId: m.providerMessageId } },
        select: { id: true, threadId: true },
      });
      if (existing) {
        await this.prisma.$transaction([
          this.prisma.emailMessage.update({ where: { id: existing.id }, data: { isRead: m.isRead, isStarred: m.isStarred } }),
          this.prisma.messageFolder.deleteMany({ where: { messageId: existing.id } }),
          this.prisma.messageFolder.createMany({ data: folderLinks.map((f) => ({ messageId: existing.id, folderId: f.id })), skipDuplicates: true }),
        ]);
        result.updated++;
        result.threadIds.add(existing.threadId);
        continue;
      }
      const threadId = await this.resolveThread(target.accountId, m);
      const outbound = m.from?.address === target.accountEmail || folderLinks.some((f) => f.type === 'SENT');
      const id = newId();
      try {
        await this.prisma.$transaction([
          this.prisma.emailMessage.create({
            data: {
              id,
              threadId,
              emailAccountId: target.accountId,
              providerMessageId: m.providerMessageId,
              internetMessageId: m.internetMessageId,
              inReplyTo: m.inReplyTo,
              references: m.references,
              direction: outbound ? 'OUTBOUND' : 'INBOUND',
              fromAddress: m.from?.address ?? '',
              fromName: m.from?.name ?? null,
              toRecipients: json(m.to),
              ccRecipients: json(m.cc),
              bccRecipients: json(m.bcc),
              replyTo: json(m.replyTo),
              subject: m.subject,
              snippet: m.snippet?.slice(0, 500) ?? null,
              bodyText: m.bodyText,
              bodyHtml: m.bodyHtml,
              headers: m.headers ? json(m.headers) : Prisma.DbNull,
              sizeBytes: m.sizeBytes,
              hasAttachments: m.hasAttachments,
              isRead: m.isRead,
              isStarred: m.isStarred,
              sentAt: m.sentAt,
              receivedAt: m.receivedAt,
            },
          }),
          this.prisma.attachment.createMany({
            data: m.attachments.map((a) => ({
              id: newId(),
              messageId: id,
              providerAttachmentId: a.providerAttachmentId,
              filename: a.filename.slice(0, 500),
              contentType: a.contentType.slice(0, 200),
              sizeBytes: a.sizeBytes,
              contentId: a.contentId,
              isInline: a.isInline,
            })),
          }),
          this.prisma.messageFolder.createMany({ data: folderLinks.map((f) => ({ messageId: id, folderId: f.id })), skipDuplicates: true }),
        ]);
        result.added++;
      } catch (e) {
        // Another sync run stored the same message concurrently: that copy wins.
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') result.updated++;
        else throw e;
      }
      result.threadIds.add(threadId);
    }
    return result;
  }

  /** Thread by provider thread id; else by In-Reply-To / References to a stored message; else a new thread. */
  private async resolveThread(accountId: string, m: NormalizedMessage): Promise<string> {
    const subject = m.subject || '(no subject)';
    const base = {
      subject: subject.slice(0, 998),
      normalizedSubject: normalizeSubject(subject).slice(0, 998),
      firstMessageAt: m.receivedAt,
      lastMessageAt: m.receivedAt,
    };
    if (m.providerThreadId) {
      const t = await this.prisma.emailThread.upsert({
        where: { emailAccountId_providerThreadId: { emailAccountId: accountId, providerThreadId: m.providerThreadId } },
        create: { id: newId(), emailAccountId: accountId, providerThreadId: m.providerThreadId, ...base },
        update: {},
        select: { id: true },
      });
      return t.id;
    }
    const refs = [m.inReplyTo, ...m.references.slice().reverse()].filter((r): r is string => !!r);
    if (refs.length) {
      const parent = await this.prisma.emailMessage.findFirst({
        where: { emailAccountId: accountId, internetMessageId: { in: refs } },
        select: { threadId: true },
      });
      if (parent) return parent.threadId;
    }
    const t = await this.prisma.emailThread.create({ data: { id: newId(), emailAccountId: accountId, ...base }, select: { id: true } });
    return t.id;
  }

  /** Deletes messages by provider id (deleted at the provider, or became drafts). */
  async removeMessages(accountId: string, providerMessageIds: string[], threadIds: Set<string>): Promise<number> {
    if (!providerMessageIds.length) return 0;
    const rows = await this.prisma.emailMessage.findMany({
      where: { emailAccountId: accountId, providerMessageId: { in: providerMessageIds } },
      select: { id: true, threadId: true },
    });
    if (!rows.length) return 0;
    rows.forEach((r) => threadIds.add(r.threadId));
    await this.prisma.emailMessage.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    return rows.length;
  }

  /** Removes one folder link (Graph: message left that folder). */
  async unlinkFromFolder(accountId: string, folderId: string, providerMessageIds: string[]) {
    if (!providerMessageIds.length) return;
    await this.prisma.messageFolder.deleteMany({
      where: { folderId, message: { emailAccountId: accountId, providerMessageId: { in: providerMessageIds } } },
    });
  }

  /** Graph: a message in no synced folder anymore was moved out of scope or deleted. */
  async removeOrphans(accountId: string, providerMessageIds: string[], threadIds: Set<string>): Promise<number> {
    if (!providerMessageIds.length) return 0;
    const orphans = await this.prisma.emailMessage.findMany({
      where: { emailAccountId: accountId, providerMessageId: { in: providerMessageIds }, folders: { none: {} } },
      select: { providerMessageId: true },
    });
    return this.removeMessages(
      accountId,
      orphans.map((o) => o.providerMessageId),
      threadIds,
    );
  }

  /**
   * Recomputes thread summaries from their messages: counts, dates, flags, and the SLA clock
   * (`awaitingReplySince` = first inbound message after the last outbound one). Threads left
   * without messages are deleted.
   */
  async refreshThreads(threadIds: Iterable<string>) {
    for (const threadId of threadIds) {
      const msgs = await this.prisma.emailMessage.findMany({
        where: { threadId },
        orderBy: { receivedAt: 'asc' },
        select: {
          direction: true,
          isRead: true,
          isStarred: true,
          receivedAt: true,
          snippet: true,
          subject: true,
          hasAttachments: true,
          folders: { select: { folder: { select: { type: true } } } },
        },
      });
      if (!msgs.length) {
        await this.prisma.emailThread.deleteMany({ where: { id: threadId } });
        continue;
      }
      const types = msgs.map((m) => new Set(m.folders.map((f) => f.folder.type)));
      const inbound = msgs.filter((m) => m.direction === 'INBOUND');
      const outbound = msgs.filter((m) => m.direction === 'OUTBOUND');
      const lastOut = outbound.at(-1)?.receivedAt ?? null;
      const firstIn = inbound[0]?.receivedAt ?? null;
      const unanswered = inbound.find((m) => !lastOut || m.receivedAt > lastOut);
      const isSpam = types.every((t) => t.has('SPAM'));
      const isTrashed = types.every((t) => t.has('TRASH'));
      const inInbox = types.some((t) => t.has('INBOX'));
      const last = msgs.at(-1)!;
      const data = {
        subject: (msgs[0]!.subject || '(no subject)').slice(0, 998),
        snippet: last.snippet,
        messageCount: msgs.length,
        unreadCount: inbound.filter((m) => !m.isRead).length,
        hasAttachments: msgs.some((m) => m.hasAttachments),
        isStarred: msgs.some((m) => m.isStarred) || types.some((t) => t.has('STARRED')),
        isSpam,
        isTrashed,
        isArchived: inbound.length > 0 && !inInbox && !isSpam && !isTrashed,
        firstMessageAt: msgs[0]!.receivedAt,
        lastMessageAt: last.receivedAt,
        lastInboundAt: inbound.at(-1)?.receivedAt ?? null,
        lastOutboundAt: lastOut,
        awaitingReplySince: unanswered?.receivedAt ?? null,
        firstResponseAt: firstIn ? (outbound.find((m) => m.receivedAt > firstIn)?.receivedAt ?? null) : null,
      };
      const before = await this.prisma.emailThread.findUnique({ where: { id: threadId } });
      if (!before) continue;
      const changed = (Object.keys(data) as (keyof typeof data)[]).some((k) => {
        const a = before[k];
        const b = data[k];
        return a instanceof Date && b instanceof Date ? a.getTime() !== b.getTime() : a !== b;
      });
      if (changed) await this.prisma.emailThread.update({ where: { id: threadId }, data: { ...data, version: { increment: 1 } } });
    }
  }
}
