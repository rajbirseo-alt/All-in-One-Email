import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@crm/db';
import { newId } from '@crm/crypto';
import { revokeToken } from '@crm/providers';
import type { MailboxAccessGrant, MailboxDetail, MailboxSummary } from '@crm/shared';
import type { z } from 'zod';
import type { mailboxAccessSchema, mailboxFoldersSchema, updateMailboxSchema } from '@crm/shared';
import { AuditService, diff } from '../audit/audit.service';
import { Errors } from '../common/errors';
import type { RequestContext } from '../common/request-context';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../prisma/prisma.service';
import { CredentialService } from './credential.service';
import { MAIL_ENDPOINTS, type MailEndpoints } from './mail-endpoints';
import { QueueService } from './queue.service';
import { SubscriptionService } from './subscription.service';

const summaryInclude = {
  department: { select: { id: true, name: true } },
  connectedBy: { select: { id: true, name: true } },
  subscriptions: { where: { status: 'ACTIVE' }, select: { expiresAt: true } },
} satisfies Prisma.EmailAccountInclude;
type AccountRow = Prisma.EmailAccountGetPayload<{ include: typeof summaryInclude }>;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

@Injectable()
export class MailboxService {
  private readonly log = new Logger(MailboxService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
    private readonly credentials: CredentialService,
    private readonly subscriptions: SubscriptionService,
    @Inject(MAIL_ENDPOINTS) private readonly endpoints: MailEndpoints,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  providers() {
    return {
      gmail: !!this.endpoints.oauth.GMAIL,
      microsoft: !!this.endpoints.oauth.MICROSOFT,
      imap: true,
      gmailPush: this.cfg.gmailPushEnabled,
      microsoftPush: this.cfg.graphPushEnabled,
      initialSyncDays: this.cfg.MAIL_INITIAL_SYNC_DAYS,
      retentionDays: this.cfg.MAIL_RETENTION_DAYS,
    };
  }

  /** Mailbox managers see every mailbox; others only mailboxes granted to them, their team or department. */
  private async visibleWhere(ctx: RequestContext): Promise<Prisma.EmailAccountWhereInput> {
    if (ctx.permissions['account.manage']) return {};
    const teams = await this.prisma.teamMember.findMany({ where: { userId: ctx.userId }, select: { teamId: true } });
    const or: Prisma.EmailAccountAccessWhereInput[] = [{ userId: ctx.userId }];
    if (teams.length) or.push({ teamId: { in: teams.map((t) => t.teamId) } });
    if (ctx.departmentId) or.push({ departmentId: ctx.departmentId });
    return { status: { not: 'DISCONNECTED' }, access: { some: { OR: or } } };
  }

  private async counts(ids: string[]) {
    const [msgs, threads] = await Promise.all([
      this.prisma.emailMessage.groupBy({ by: ['emailAccountId'], where: { emailAccountId: { in: ids } }, _count: { _all: true }, _max: { receivedAt: true } }),
      this.prisma.emailThread.groupBy({ by: ['emailAccountId'], where: { emailAccountId: { in: ids } }, _count: { _all: true } }),
    ]);
    return {
      msgs: new Map(msgs.map((m) => [m.emailAccountId, { count: m._count._all, newest: m._max.receivedAt }])),
      threads: new Map(threads.map((t) => [t.emailAccountId, t._count._all])),
    };
  }

  private toSummary(a: AccountRow, c: Awaited<ReturnType<MailboxService['counts']>>): MailboxSummary {
    const m = c.msgs.get(a.id);
    return {
      id: a.id,
      provider: a.provider,
      emailAddress: a.emailAddress,
      displayName: a.displayName,
      department: a.department,
      status: a.status,
      lastSyncedAt: iso(a.lastSyncedAt),
      lastSuccessAt: iso(a.lastSuccessAt),
      lastError: a.lastError,
      consecutiveFailures: a.consecutiveFailures,
      messageCount: m?.count ?? 0,
      threadCount: c.threads.get(a.id) ?? 0,
      newestMessageAt: iso(m?.newest ?? null),
      pushActive: a.subscriptions.some((s) => s.expiresAt > new Date()),
      disconnectedAt: iso(a.disconnectedAt),
      purgeAfter: iso(a.purgeAfter),
      purgedAt: iso(a.purgedAt),
      connectedBy: a.connectedBy,
      createdAt: a.createdAt.toISOString(),
    };
  }

  async list(ctx: RequestContext): Promise<MailboxSummary[]> {
    const rows = await this.prisma.emailAccount.findMany({ where: await this.visibleWhere(ctx), include: summaryInclude, orderBy: { emailAddress: 'asc' } });
    const c = await this.counts(rows.map((r) => r.id));
    return rows.map((r) => this.toSummary(r, c));
  }

  private async getOrThrow(id: string) {
    const a = await this.prisma.emailAccount.findUnique({ where: { id } });
    if (!a) throw Errors.notFound('Mailbox');
    return a;
  }

  async detail(id: string): Promise<MailboxDetail> {
    const a = await this.prisma.emailAccount.findUnique({
      where: { id },
      include: {
        ...summaryInclude,
        folders: { orderBy: [{ type: 'asc' }, { name: 'asc' }] },
        access: {
          include: { user: { select: { id: true, name: true, email: true } }, team: { select: { id: true, name: true } }, department: { select: { id: true, name: true } } },
          orderBy: { createdAt: 'asc' },
        },
        syncLogs: { orderBy: { startedAt: 'desc' }, take: 20 },
      },
    });
    if (!a) throw Errors.notFound('Mailbox');
    const [c, perFolder, subs] = await Promise.all([
      this.counts([a.id]),
      this.prisma.messageFolder.groupBy({ by: ['folderId'], where: { folder: { emailAccountId: a.id } }, _count: { _all: true } }),
      this.prisma.emailWebhookSubscription.findMany({ where: { emailAccountId: a.id }, orderBy: { createdAt: 'desc' }, take: 10 }),
    ]);
    const folderCounts = new Map(perFolder.map((f) => [f.folderId, f._count._all]));
    return {
      ...this.toSummary(a, c),
      syncFromDate: iso(a.syncFromDate),
      aiEnabled: a.aiEnabled,
      folders: a.folders.map((f) => ({
        id: f.id,
        name: f.name,
        type: f.type,
        syncEnabled: f.syncEnabled,
        messageCount: folderCounts.get(f.id) ?? 0,
        lastSyncedAt: iso(f.lastSyncedAt),
      })),
      subscriptions: subs.map((s) => ({
        id: s.id,
        provider: s.provider,
        resource: s.resource,
        status: s.status,
        expiresAt: s.expiresAt.toISOString(),
        lastNotifiedAt: iso(s.lastNotifiedAt),
      })),
      access: a.access.map((g): MailboxAccessGrant => ({ id: g.id, level: g.level, user: g.user, team: g.team, department: g.department })),
      syncLogs: a.syncLogs.map((l) => ({
        id: l.id,
        kind: l.kind,
        status: l.status,
        messagesAdded: l.messagesAdded,
        messagesUpdated: l.messagesUpdated,
        error: l.error,
        startedAt: l.startedAt.toISOString(),
        finishedAt: iso(l.finishedAt),
      })),
    };
  }

  async update(ctx: RequestContext, id: string, input: z.infer<typeof updateMailboxSchema>) {
    const before = await this.getOrThrow(id);
    if (input.departmentId && !(await this.prisma.department.findUnique({ where: { id: input.departmentId } }))) {
      throw Errors.validation([{ path: 'departmentId', message: 'Unknown department' }]);
    }
    await this.prisma.$transaction(async (tx) => {
      const after = await tx.emailAccount.update({ where: { id }, data: input });
      const d = diff(before, { displayName: after.displayName, departmentId: after.departmentId, aiEnabled: after.aiEnabled });
      if (d.changed) await this.audit.record(tx, ctx, { action: 'account.update', entityType: 'EmailAccount', entityId: id, before: d.before, after: d.after });
    });
    return this.detail(id);
  }

  async setFolders(ctx: RequestContext, id: string, input: z.infer<typeof mailboxFoldersSchema>) {
    await this.getOrThrow(id);
    const folders = await this.prisma.emailFolder.findMany({ where: { emailAccountId: id, id: { in: input.folders.map((f) => f.folderId) } } });
    if (folders.length !== new Set(input.folders.map((f) => f.folderId)).size) throw Errors.validation([{ path: 'folders', message: 'Unknown folder' }]);
    const byId = new Map(folders.map((f) => [f.id, f]));
    const changes = input.folders.filter((f) => byId.get(f.folderId)!.syncEnabled !== f.syncEnabled);
    if (changes.length) {
      await this.prisma.$transaction(async (tx) => {
        for (const c of changes) {
          // Re-enabled folders start a fresh delta so their existing mail is imported.
          await tx.emailFolder.update({ where: { id: c.folderId }, data: { syncEnabled: c.syncEnabled, ...(c.syncEnabled ? { deltaLink: null } : {}) } });
        }
        await this.audit.record(tx, ctx, {
          action: 'account.folders',
          entityType: 'EmailAccount',
          entityId: id,
          after: changes.map((c) => ({ folder: byId.get(c.folderId)!.name, syncEnabled: c.syncEnabled })),
        });
      });
      await this.queue.enqueueSync(id, 'INCREMENTAL');
    }
    return this.detail(id);
  }

  async syncNow(ctx: RequestContext, id: string, full: boolean) {
    const a = await this.getOrThrow(id);
    if (a.status === 'DISCONNECTED' || a.status === 'PAUSED') throw Errors.conflict('Resume or reconnect this mailbox first', 'MAILBOX_INACTIVE');
    if (a.status === 'NEEDS_REAUTH') throw Errors.conflict('This mailbox must be reconnected first', 'NEEDS_REAUTH');
    await this.prisma.$transaction(async (tx) => {
      if (full) {
        // A full resync re-reads the window; stored messages are deduplicated.
        await tx.emailAccount.update({ where: { id }, data: { status: 'INITIAL_SYNC', gmailHistoryId: null } });
        await tx.emailFolder.updateMany({ where: { emailAccountId: id }, data: { deltaLink: null, lastUid: null } });
      }
      await this.audit.record(tx, ctx, { action: full ? 'account.resync' : 'account.sync', entityType: 'EmailAccount', entityId: id });
    });
    await this.queue.enqueueSync(id, full ? 'INITIAL' : 'INCREMENTAL');
  }

  async pause(ctx: RequestContext, id: string) {
    const a = await this.getOrThrow(id);
    if (a.status === 'DISCONNECTED') throw Errors.conflict('This mailbox is disconnected', 'MAILBOX_INACTIVE');
    if (a.status === 'PAUSED') return;
    await this.prisma.$transaction(async (tx) => {
      await tx.emailAccount.update({ where: { id }, data: { status: 'PAUSED' } });
      await this.audit.record(tx, ctx, { action: 'account.pause', entityType: 'EmailAccount', entityId: id, before: { status: a.status }, after: { status: 'PAUSED' } });
    });
  }

  async resume(ctx: RequestContext, id: string) {
    const a = await this.prisma.emailAccount.findUnique({ where: { id }, include: { folders: { select: { deltaLink: true } } } });
    if (!a) throw Errors.notFound('Mailbox');
    if (a.status !== 'PAUSED') throw Errors.conflict('This mailbox is not paused', 'NOT_PAUSED');
    const status = a.gmailHistoryId || a.folders.some((f) => f.deltaLink) ? 'ACTIVE' : 'INITIAL_SYNC';
    await this.prisma.$transaction(async (tx) => {
      await tx.emailAccount.update({ where: { id }, data: { status, consecutiveFailures: 0 } });
      await this.audit.record(tx, ctx, { action: 'account.resume', entityType: 'EmailAccount', entityId: id, before: { status: 'PAUSED' }, after: { status } });
    });
    await this.queue.enqueueSync(id, status === 'ACTIVE' ? 'INCREMENTAL' : 'INITIAL');
  }

  /**
   * Disconnect: stop push, revoke the grant at the provider (Google; Microsoft has no per-token
   * revocation), delete the stored credential and schedule the content purge.
   */
  async disconnect(ctx: RequestContext, id: string) {
    const a = await this.getOrThrow(id);
    if (a.status === 'DISCONNECTED') return this.detail(id);
    await this.subscriptions.removeAll(id);
    let revoked = false;
    const client = this.endpoints.oauth[a.provider as 'GMAIL' | 'MICROSOFT'];
    const refreshToken = await this.credentials.refreshTokenOf(id);
    if (client && refreshToken) revoked = await revokeToken(client, refreshToken, this.endpoints.fetch);
    const purgeAfter = new Date(Date.now() + this.cfg.MAIL_RETENTION_DAYS * 86_400_000);
    await this.prisma.$transaction(async (tx) => {
      await tx.emailCredential.deleteMany({ where: { emailAccountId: id } });
      await tx.emailAccount.update({ where: { id }, data: { status: 'DISCONNECTED', disconnectedAt: new Date(), purgeAfter } });
      await this.audit.record(tx, ctx, {
        action: 'account.disconnect',
        entityType: 'EmailAccount',
        entityId: id,
        before: { status: a.status },
        after: { status: 'DISCONNECTED', purgeAfter },
        metadata: { providerRevoked: revoked },
      });
    });
    return this.detail(id);
  }

  async setAccess(ctx: RequestContext, id: string, input: z.infer<typeof mailboxAccessSchema>) {
    await this.getOrThrow(id);
    const ids = (k: 'userId' | 'teamId' | 'departmentId') => [...new Set(input.grants.map((g) => g[k]).filter((v): v is string => !!v))];
    const [users, teams, deps] = await Promise.all([
      this.prisma.user.count({ where: { id: { in: ids('userId') } } }),
      this.prisma.team.count({ where: { id: { in: ids('teamId') } } }),
      this.prisma.department.count({ where: { id: { in: ids('departmentId') } } }),
    ]);
    if (users !== ids('userId').length || teams !== ids('teamId').length || deps !== ids('departmentId').length) {
      throw Errors.validation([{ path: 'grants', message: 'Unknown employee, team or department' }]);
    }
    const keyOf = (g: { userId?: string | null; teamId?: string | null; departmentId?: string | null }) => `${g.userId ?? ''}|${g.teamId ?? ''}|${g.departmentId ?? ''}`;
    if (new Set(input.grants.map(keyOf)).size !== input.grants.length) throw Errors.validation([{ path: 'grants', message: 'Each grantee can be listed once' }]);

    const before = await this.prisma.emailAccountAccess.findMany({ where: { emailAccountId: id } });
    await this.prisma.$transaction(async (tx) => {
      await tx.emailAccountAccess.deleteMany({ where: { emailAccountId: id } });
      await tx.emailAccountAccess.createMany({
        data: input.grants.map((g) => ({
          id: newId(),
          emailAccountId: id,
          userId: g.userId ?? null,
          teamId: g.teamId ?? null,
          departmentId: g.departmentId ?? null,
          level: g.level,
          grantedById: ctx.userId,
        })),
      });
      const fmt = (g: { userId?: string | null; teamId?: string | null; departmentId?: string | null; level: string }) => ({ grantee: keyOf(g), level: g.level });
      await this.audit.record(tx, ctx, {
        action: 'account.access',
        entityType: 'EmailAccount',
        entityId: id,
        before: before.map(fmt),
        after: input.grants.map(fmt),
      });
    });
    return this.detail(id);
  }
}
