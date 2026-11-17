import { Controller, Get, Query } from '@nestjs/common';
import { auditQuery, type AuditEntry, type Page } from '@crm/shared';
import type { Prisma } from '@crm/db';
import type { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { RequirePermission } from '../common/decorators';
import { ZodPipe } from '../common/zod.pipe';

@Controller('audit-logs')
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  @RequirePermission('audit.read')
  @Get()
  async list(@Query(new ZodPipe(auditQuery)) q: z.infer<typeof auditQuery>): Promise<Page<AuditEntry>> {
    const where: Prisma.AuditLogWhereInput = {
      ...(q.entityType ? { entityType: q.entityType } : {}),
      ...(q.entityId ? { entityId: q.entityId } : {}),
      ...(q.actorId ? { actorId: q.actorId } : {}),
      ...(q.action ? { action: { startsWith: q.action } } : {}),
      ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
    };
    const rows = await this.prisma.auditLog.findMany({
      where,
      include: { actor: { select: { id: true, name: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const more = rows.length > q.limit;
    const items = rows.slice(0, q.limit);
    return {
      items: items.map((r) => ({
        id: r.id,
        actor: r.actor,
        actorType: r.actorType,
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        ip: r.ip,
        before: r.before,
        after: r.after,
        metadata: r.metadata,
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor: more ? items[items.length - 1]!.id : null,
    };
  }
}
