import { Injectable } from '@nestjs/common';
import { Prisma } from '@crm/db';
import { newId } from '@crm/crypto';
import type { CalendarView, SlaPolicyView, calendarSchema, holidaySchema, slaPolicySchema } from '@crm/shared';
import type { z } from 'zod';
import { AccessPolicy } from '../access/access-policy.service';
import { AuditService } from '../audit/audit.service';
import { Errors } from '../common/errors';
import type { RequestContext } from '../common/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { WEEKDAYS, isValidTimezone, weeklyHoursProblems, type WeeklyHours } from './business-clock';
import { SlaService } from './sla.service';

type CalendarInput = z.infer<typeof calendarSchema>;
type PolicyInput = z.infer<typeof slaPolicySchema>;

/**
 * SLA policies and business calendars (`sla.manage`). Company-wide holders manage everything;
 * department-scoped holders (department managers) manage the policies of their own departments
 * and can read the shared calendars.
 */
@Injectable()
export class SlaAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessPolicy,
    private readonly audit: AuditService,
    private readonly sla: SlaService,
  ) {}

  private isAll(ctx: RequestContext) {
    return ctx.permissions['sla.manage'] === 'ALL';
  }

  private requireAll(ctx: RequestContext) {
    if (!this.isAll(ctx)) throw Errors.forbidden('Only company-wide SLA managers can change business calendars');
  }

  // ───────────── calendars ─────────────

  async calendars(): Promise<CalendarView[]> {
    const rows = await this.prisma.businessCalendar.findMany({
      orderBy: { name: 'asc' },
      include: { holidays: { orderBy: { date: 'asc' } }, departments: { select: { id: true, name: true } }, _count: { select: { slaPolicies: true } } },
    });
    return rows.map((c) => ({
      id: c.id,
      name: c.name,
      timezone: c.timezone,
      weeklyHours: c.weeklyHours as unknown as CalendarView['weeklyHours'],
      holidays: c.holidays.map((h) => ({ id: h.id, date: h.date.toISOString().slice(0, 10), name: h.name })),
      departments: c.departments,
      usedByPolicies: c._count.slaPolicies,
    }));
  }

  private checkCalendar(input: CalendarInput) {
    const problems: { path: string; message: string }[] = [];
    if (!isValidTimezone(input.timezone)) problems.push({ path: 'timezone', message: 'Unknown time zone (use e.g. Asia/Kolkata)' });
    for (const p of weeklyHoursProblems(input.weeklyHours as WeeklyHours)) problems.push({ path: 'weeklyHours', message: p });
    if (!WEEKDAYS.some((d) => input.weeklyHours[d].length)) problems.push({ path: 'weeklyHours', message: 'Add opening hours for at least one day' });
    if (problems.length) throw Errors.validation(problems);
  }

  async createCalendar(ctx: RequestContext, input: CalendarInput) {
    this.requireAll(ctx);
    this.checkCalendar(input);
    const id = newId();
    await this.prisma.$transaction(async (tx) => {
      await tx.businessCalendar.create({ data: { id, name: input.name, timezone: input.timezone, weeklyHours: input.weeklyHours as Prisma.InputJsonValue } });
      await this.audit.record(tx, ctx, { action: 'calendar.create', entityType: 'BusinessCalendar', entityId: id, after: input as unknown as Record<string, unknown> });
    });
    return (await this.calendars()).find((c) => c.id === id)!;
  }

  async updateCalendar(ctx: RequestContext, id: string, input: CalendarInput) {
    this.requireAll(ctx);
    this.checkCalendar(input);
    const before = await this.prisma.businessCalendar.findUnique({ where: { id } });
    if (!before) throw Errors.notFound('Calendar');
    await this.prisma.$transaction(async (tx) => {
      await tx.businessCalendar.update({ where: { id }, data: { name: input.name, timezone: input.timezone, weeklyHours: input.weeklyHours as Prisma.InputJsonValue } });
      // Due times of running clocks move with the hours, but steps that are now in the past are not alerted retroactively.
      await tx.slaPolicy.updateMany({ where: { calendarId: id }, data: { updatedAt: new Date() } });
      await this.audit.record(tx, ctx, {
        action: 'calendar.update',
        entityType: 'BusinessCalendar',
        entityId: id,
        before: { name: before.name, timezone: before.timezone, weeklyHours: before.weeklyHours },
        after: input as unknown as Record<string, unknown>,
      });
    });
    await this.sla.reevaluateOpen();
    return (await this.calendars()).find((c) => c.id === id)!;
  }

  async deleteCalendar(ctx: RequestContext, id: string) {
    this.requireAll(ctx);
    const c = await this.prisma.businessCalendar.findUnique({ where: { id }, include: { _count: { select: { slaPolicies: true } } } });
    if (!c) throw Errors.notFound('Calendar');
    if (c._count.slaPolicies) throw Errors.conflict('SLA policies still use this calendar. Move or delete them first.', 'CALENDAR_IN_USE');
    await this.prisma.$transaction(async (tx) => {
      await tx.department.updateMany({ where: { calendarId: id }, data: { calendarId: null } });
      await tx.businessCalendar.delete({ where: { id } });
      await this.audit.record(tx, ctx, { action: 'calendar.delete', entityType: 'BusinessCalendar', entityId: id, before: { name: c.name } });
    });
  }

  async addHoliday(ctx: RequestContext, calendarId: string, input: z.infer<typeof holidaySchema>) {
    this.requireAll(ctx);
    const date = new Date(`${input.date}T00:00:00Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== input.date) throw Errors.validation([{ path: 'date', message: 'Not a real date' }]);
    if (!(await this.prisma.businessCalendar.count({ where: { id: calendarId } }))) throw Errors.notFound('Calendar');
    const id = newId();
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.holiday.create({ data: { id, calendarId, date, name: input.name } });
        await tx.slaPolicy.updateMany({ where: { calendarId }, data: { updatedAt: new Date() } });
        await this.audit.record(tx, ctx, { action: 'calendar.holiday.add', entityType: 'BusinessCalendar', entityId: calendarId, after: { date: input.date, name: input.name } });
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw Errors.conflict('That date is already a holiday', 'DUPLICATE_HOLIDAY');
      throw e;
    }
    await this.sla.reevaluateOpen();
    return { id, date: input.date, name: input.name };
  }

  async removeHoliday(ctx: RequestContext, calendarId: string, holidayId: string) {
    this.requireAll(ctx);
    const h = await this.prisma.holiday.findFirst({ where: { id: holidayId, calendarId } });
    if (!h) throw Errors.notFound('Holiday');
    await this.prisma.$transaction(async (tx) => {
      await tx.holiday.delete({ where: { id: holidayId } });
      await tx.slaPolicy.updateMany({ where: { calendarId }, data: { updatedAt: new Date() } });
      await this.audit.record(tx, ctx, { action: 'calendar.holiday.remove', entityType: 'BusinessCalendar', entityId: calendarId, before: { date: h.date.toISOString().slice(0, 10), name: h.name } });
    });
    await this.sla.reevaluateOpen();
  }

  // ───────────── policies ─────────────

  private async canEditPolicy(ctx: RequestContext, departmentId: string | null, isDefault: boolean) {
    if (this.isAll(ctx)) return true;
    if (!departmentId || isDefault) return false;
    return (await this.access.departmentIds(ctx)).includes(departmentId);
  }

  /** 404 for another department's policy (not listed for the caller), 403 for a visible one they cannot change. */
  private async editable(ctx: RequestContext, p: { departmentId: string | null; isDefault: boolean } | null) {
    if (!p) throw Errors.notFound('SLA policy');
    if (!this.isAll(ctx) && p.departmentId && !(await this.access.departmentIds(ctx)).includes(p.departmentId)) throw Errors.notFound('SLA policy');
    if (!(await this.canEditPolicy(ctx, p.departmentId, p.isDefault))) throw Errors.forbidden('Company-wide SLA policies can only be changed by an administrator');
  }

  async policies(ctx: RequestContext): Promise<SlaPolicyView[]> {
    const own = this.isAll(ctx) ? null : await this.access.departmentIds(ctx);
    const rows = await this.prisma.slaPolicy.findMany({
      // Department managers see their departments' policies and the company-wide ones that also apply to them.
      where: own ? { OR: [{ departmentId: { in: own } }, { departmentId: null }] } : {},
      include: { department: { select: { id: true, name: true } }, calendar: { select: { id: true, name: true, timezone: true } }, steps: { orderBy: [{ afterBusinessMinutes: 'asc' }, { action: 'asc' }] } },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
    return Promise.all(
      rows.map(async (p) => ({
        id: p.id,
        name: p.name,
        department: p.department,
        priority: p.priority,
        calendar: p.calendar,
        isEnabled: p.isEnabled,
        isDefault: p.isDefault,
        steps: p.steps.map((s) => ({ id: s.id, afterBusinessMinutes: s.afterBusinessMinutes, action: s.action, marksOverdue: s.marksOverdue })),
        canEdit: await this.canEditPolicy(ctx, p.departmentId, p.isDefault),
      })),
    );
  }

  private async checkPolicy(ctx: RequestContext, input: PolicyInput, selfId: string | null) {
    const problems: { path: string; message: string }[] = [];
    if (input.isDefault && (input.departmentId || input.priority)) problems.push({ path: 'isDefault', message: 'The default policy applies to every department and priority' });
    if (!input.isDefault && !input.departmentId && !input.priority) problems.push({ path: 'departmentId', message: 'Choose a department or a priority (or make it the default policy)' });
    const keys = input.steps.map((s) => `${s.afterBusinessMinutes}:${s.action}`);
    if (new Set(keys).size !== keys.length) problems.push({ path: 'steps', message: 'The same action is listed twice at the same time' });
    if (!input.steps.some((s) => s.marksOverdue)) problems.push({ path: 'steps', message: 'Mark the step at which a conversation counts as overdue' });
    if (!(await this.prisma.businessCalendar.count({ where: { id: input.calendarId } }))) problems.push({ path: 'calendarId', message: 'Unknown calendar' });
    if (input.departmentId && !(await this.prisma.department.count({ where: { id: input.departmentId } }))) problems.push({ path: 'departmentId', message: 'Unknown department' });
    if (problems.length) throw Errors.validation(problems);
    if (!(await this.canEditPolicy(ctx, input.departmentId, input.isDefault))) throw Errors.forbidden('You can only manage SLA policies of your own department');
    if (input.isEnabled) {
      const clash = await this.prisma.slaPolicy.findFirst({
        where: { isEnabled: true, ...(selfId ? { id: { not: selfId } } : {}), ...(input.isDefault ? { isDefault: true } : { departmentId: input.departmentId, priority: input.priority, isDefault: false }) },
        select: { name: true },
      });
      if (clash) throw Errors.conflict(`"${clash.name}" already covers the same ${input.isDefault ? 'default' : 'department and priority'}. Disable it first.`, 'POLICY_OVERLAP');
    }
  }

  async createPolicy(ctx: RequestContext, input: PolicyInput) {
    await this.checkPolicy(ctx, input, null);
    const id = newId();
    await this.prisma.$transaction(async (tx) => {
      await tx.slaPolicy.create({
        data: {
          id,
          name: input.name,
          departmentId: input.departmentId,
          priority: input.priority,
          calendarId: input.calendarId,
          isEnabled: input.isEnabled,
          isDefault: input.isDefault,
          steps: { create: input.steps.map((s) => ({ id: newId(), afterBusinessMinutes: s.afterBusinessMinutes, action: s.action, marksOverdue: s.marksOverdue })) },
        },
      });
      await this.audit.record(tx, ctx, { action: 'sla.policy.create', entityType: 'SlaPolicy', entityId: id, after: input as unknown as Record<string, unknown> });
    });
    await this.sla.reevaluateOpen();
    return (await this.policies(ctx)).find((p) => p.id === id)!;
  }

  async updatePolicy(ctx: RequestContext, id: string, input: PolicyInput) {
    const before = await this.prisma.slaPolicy.findUnique({ where: { id }, include: { steps: true } });
    await this.editable(ctx, before);
    if (!before) throw Errors.notFound('SLA policy');
    await this.checkPolicy(ctx, input, id);
    await this.prisma.$transaction(async (tx) => {
      // Steps are replaced; events of removed steps go with them (their cycles are over or restart cleanly).
      await tx.slaStep.deleteMany({ where: { policyId: id } });
      await tx.slaPolicy.update({
        where: { id },
        data: {
          name: input.name,
          departmentId: input.departmentId,
          priority: input.priority,
          calendarId: input.calendarId,
          isEnabled: input.isEnabled,
          isDefault: input.isDefault,
          steps: { create: input.steps.map((s) => ({ id: newId(), afterBusinessMinutes: s.afterBusinessMinutes, action: s.action, marksOverdue: s.marksOverdue })) },
        },
      });
      await this.audit.record(tx, ctx, {
        action: 'sla.policy.update',
        entityType: 'SlaPolicy',
        entityId: id,
        before: { name: before.name, departmentId: before.departmentId, priority: before.priority, calendarId: before.calendarId, isEnabled: before.isEnabled, steps: before.steps.map((s) => ({ afterBusinessMinutes: s.afterBusinessMinutes, action: s.action, marksOverdue: s.marksOverdue })) },
        after: input as unknown as Record<string, unknown>,
      });
    });
    await this.sla.reevaluateOpen();
    return (await this.policies(ctx)).find((p) => p.id === id)!;
  }

  async deletePolicy(ctx: RequestContext, id: string) {
    const p = await this.prisma.slaPolicy.findUnique({ where: { id } });
    await this.editable(ctx, p);
    if (!p) return;
    await this.prisma.$transaction(async (tx) => {
      await tx.emailThread.updateMany({ where: { slaPolicyId: id }, data: { slaPolicyId: null } });
      await tx.slaPolicy.delete({ where: { id } });
      await this.audit.record(tx, ctx, { action: 'sla.policy.delete', entityType: 'SlaPolicy', entityId: id, before: { name: p.name, departmentId: p.departmentId, priority: p.priority } });
    });
    await this.sla.reevaluateOpen();
  }
}
