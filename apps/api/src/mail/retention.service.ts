import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { FileStore } from '../storage/file-store.service';

/**
 * Deletes the mail content of mailboxes disconnected longer than MAIL_RETENTION_DAYS (120).
 * The account row, its sync logs and the audit trail stay; audit logs are kept 7 years.
 */
@Injectable()
export class RetentionService {
  private readonly log = new Logger(RetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly files: FileStore,
  ) {}

  async purgeDue(now = new Date()): Promise<number> {
    const due = await this.prisma.emailAccount.findMany({
      where: { status: 'DISCONNECTED', purgeAfter: { lte: now }, purgedAt: null },
      select: { id: true, emailAddress: true },
    });
    for (const a of due) {
      // Stored attachment files (object storage) go with the mail; the rows cascade below.
      const stored = await this.prisma.attachment.findMany({
        where: { storageKey: { not: null }, OR: [{ message: { emailAccountId: a.id } }, { draft: { emailAccountId: a.id } }] },
        select: { storageKey: true },
      });
      await this.files.remove(stored.map((s) => s.storageKey));
      await this.prisma.$transaction(
        async (tx) => {
          const threads = await tx.emailThread.deleteMany({ where: { emailAccountId: a.id } });
          await tx.emailMessage.deleteMany({ where: { emailAccountId: a.id } });
          await tx.emailFolder.deleteMany({ where: { emailAccountId: a.id } });
          await tx.emailWebhookSubscription.deleteMany({ where: { emailAccountId: a.id } });
          await tx.emailAccount.update({ where: { id: a.id }, data: { purgedAt: now, gmailHistoryId: null } });
          await this.audit.record(tx, { userId: null, actorType: 'SYSTEM' }, {
            action: 'account.purge',
            entityType: 'EmailAccount',
            entityId: a.id,
            metadata: { emailAddress: a.emailAddress, threadsDeleted: threads.count },
          });
        },
        { timeout: 120_000 },
      );
      this.log.log(`Purged mail content of disconnected mailbox ${a.id}`);
    }
    return due.length;
  }
}
