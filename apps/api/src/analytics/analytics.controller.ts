import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import { analyticsGroupQuery, analyticsRangeQuery, exportQuery, trendsQuery, workloadQuery } from '@crm/shared';
import { AuditService } from '../audit/audit.service';
import { Ctx, RequirePermission } from '../common/decorators';
import type { RequestContext } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { AnalyticsService } from './analytics.service';
import { toCsv } from './csv';

type Range = z.infer<typeof analyticsRangeQuery>;
const mins = (n: number | null) => (n === null ? '' : n);

/** Dashboards and reports (docs/03 "Analytics"). All figures are limited to the caller's report.read scope. */
@Controller('analytics')
export class AnalyticsController {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
  ) {}

  @RequirePermission('report.read')
  @Get('overview')
  overview(@Ctx() ctx: RequestContext, @Query(new ZodPipe(analyticsRangeQuery)) q: Range) {
    return this.analytics.overview(ctx, q);
  }

  @RequirePermission('report.read')
  @Get('md')
  md(@Ctx() ctx: RequestContext, @Query(new ZodPipe(analyticsRangeQuery)) q: Range) {
    return this.analytics.md(ctx, q);
  }

  @RequirePermission('report.read')
  @Get('me')
  me(@Ctx() ctx: RequestContext, @Query(new ZodPipe(analyticsRangeQuery)) q: Range) {
    return this.analytics.me(ctx, q);
  }

  @RequirePermission('report.read')
  @Get('response-times')
  responseTimes(@Ctx() ctx: RequestContext, @Query(new ZodPipe(analyticsGroupQuery)) q: z.infer<typeof analyticsGroupQuery>) {
    return this.analytics.responseTimes(ctx, q);
  }

  @RequirePermission('report.read')
  @Get('workload')
  workload(@Ctx() ctx: RequestContext, @Query(new ZodPipe(workloadQuery)) q: z.infer<typeof workloadQuery>) {
    return this.analytics.workload(ctx, q);
  }

  @RequirePermission('report.read')
  @Get('trends')
  trends(@Ctx() ctx: RequestContext, @Query(new ZodPipe(trendsQuery)) q: z.infer<typeof trendsQuery>) {
    return this.analytics.trends(ctx, q);
  }

  @RequirePermission('report.read')
  @Get('leads/funnel')
  funnel(@Ctx() ctx: RequestContext, @Query(new ZodPipe(analyticsRangeQuery)) q: Range) {
    return this.analytics.leadFunnel(ctx, q);
  }

  @RequirePermission('report.read')
  @Get('accounts')
  accounts(@Ctx() ctx: RequestContext, @Query(new ZodPipe(analyticsRangeQuery)) q: Range) {
    return this.analytics.accounts(ctx, q);
  }

  /** CSV of one report for the range, with the same scope as the dashboards. Audited. */
  @RequirePermission('report.export')
  @Get('export.csv')
  async export(@Ctx() ctx: RequestContext, @Query(new ZodPipe(exportQuery)) q: z.infer<typeof exportQuery>, @Res({ passthrough: true }) res: Response) {
    if (!ctx.permissions['report.read']) {
      res.status(403);
      return 'You do not have access to reports';
    }
    const r = this.analytics.resolveRange(q);
    let header: string[];
    let rows: (string | number | null)[][];
    switch (q.report) {
      case 'productivity': {
        const [rt, load] = await Promise.all([this.analytics.responseTimes(ctx, { ...q, groupBy: 'user' }), this.analytics.workload(ctx, { groupBy: 'user', departmentId: q.departmentId })]);
        const keys = [...new Set([...rt.map((x) => x.key), ...load.map((x) => x.key)])];
        header = ['Employee', 'Open now', 'Pending now', 'Overdue now', 'Incoming', 'Outgoing', 'Replies', 'Avg reply (business min)', 'Avg reply (clock min)', 'First replies', 'Avg first reply (business min)', 'Closed', 'SLA breaches'];
        rows = keys.map((k) => {
          const a = rt.find((x) => x.key === k);
          const l = load.find((x) => x.key === k);
          return [a?.name ?? l?.name ?? '', l?.open ?? 0, l?.pending ?? 0, l?.overdue ?? 0, a?.incoming ?? 0, a?.outgoing ?? 0, a?.replies ?? 0, mins(a?.avgBusinessMinutes ?? null), mins(a?.avgMinutes ?? null), a?.firstReplies ?? 0, mins(a?.avgFirstBusinessMinutes ?? null), a?.closed ?? 0, a?.slaBreaches ?? 0];
        });
        break;
      }
      case 'departments':
      case 'accounts': {
        const rt = await this.analytics.responseTimes(ctx, { ...q, groupBy: q.report === 'departments' ? 'department' : 'account' });
        header = [q.report === 'departments' ? 'Department' : 'Mailbox', 'Incoming', 'Outgoing', 'Replies', 'Avg reply (business min)', 'Avg reply (clock min)', 'First replies', 'Avg first reply (business min)', 'Avg first reply (clock min)', 'Closed', 'SLA breaches'];
        rows = rt.map((a) => [a.name, a.incoming, a.outgoing, a.replies, mins(a.avgBusinessMinutes), mins(a.avgMinutes), a.firstReplies, mins(a.avgFirstBusinessMinutes), mins(a.avgFirstMinutes), a.closed, a.slaBreaches]);
        break;
      }
      case 'daily': {
        const pts = await this.analytics.daily(ctx, q);
        header = ['Date', 'Incoming', 'Outgoing', 'New conversations', 'Replies', 'Avg reply (business min)', 'Avg reply (clock min)', 'Closed', 'SLA breaches'];
        rows = pts.map((p) => [p.bucket, p.values.incoming ?? 0, p.values.outgoing ?? 0, p.values.newThreads ?? 0, p.values.replies ?? 0, mins(p.values.avgBusinessResponse ?? null), mins(p.values.avgResponse ?? null), p.values.closed ?? 0, p.values.slaBreaches ?? 0]);
        break;
      }
      case 'leads': {
        const f = await this.analytics.leadFunnel(ctx, q);
        header = ['Stage', 'Leads now in this stage', 'Leads that reached this stage'];
        rows = f.byStatus.map((b) => [b.status, b.count, f.reached.find((x) => x.status === b.status)?.count ?? '']);
        break;
      }
      case 'workload': {
        const load = await this.analytics.workload(ctx, { groupBy: 'user', departmentId: q.departmentId });
        header = ['Employee', 'Open', 'Pending reply', 'Overdue'];
        rows = load.map((l) => [l.name, l.open, l.pending, l.overdue]);
        break;
      }
    }
    await this.audit.record(this.prisma, ctx, {
      action: 'report.export',
      entityType: 'Report',
      entityId: q.report,
      metadata: { report: q.report, range: q.range, from: r.fromDate, to: r.toDate, departmentId: q.departmentId ?? null, rows: rows.length },
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${q.report}-${r.fromDate}-to-${r.toDate}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    return toCsv(header, rows);
  }
}
