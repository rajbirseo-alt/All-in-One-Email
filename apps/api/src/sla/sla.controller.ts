import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import type { z } from 'zod';
import { calendarSchema, holidaySchema, slaPolicySchema } from '@crm/shared';
import { Ctx, RequirePermission } from '../common/decorators';
import type { RequestContext } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { SlaAdminService } from './sla-admin.service';

@Controller()
export class SlaController {
  constructor(private readonly admin: SlaAdminService) {}

  @RequirePermission('sla.manage')
  @Get('calendars')
  calendars() {
    return this.admin.calendars();
  }

  @RequirePermission('sla.manage')
  @Post('calendars')
  createCalendar(@Ctx() ctx: RequestContext, @Body(new ZodPipe(calendarSchema)) b: z.infer<typeof calendarSchema>) {
    return this.admin.createCalendar(ctx, b);
  }

  @RequirePermission('sla.manage')
  @Put('calendars/:id')
  updateCalendar(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(calendarSchema)) b: z.infer<typeof calendarSchema>) {
    return this.admin.updateCalendar(ctx, id, b);
  }

  @RequirePermission('sla.manage')
  @Delete('calendars/:id')
  @HttpCode(204)
  deleteCalendar(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.admin.deleteCalendar(ctx, id);
  }

  @RequirePermission('sla.manage')
  @Post('calendars/:id/holidays')
  addHoliday(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(holidaySchema)) b: z.infer<typeof holidaySchema>) {
    return this.admin.addHoliday(ctx, id, b);
  }

  @RequirePermission('sla.manage')
  @Delete('calendars/:id/holidays/:holidayId')
  @HttpCode(204)
  removeHoliday(@Ctx() ctx: RequestContext, @Param('id') id: string, @Param('holidayId') holidayId: string) {
    return this.admin.removeHoliday(ctx, id, holidayId);
  }

  @RequirePermission('sla.manage')
  @Get('sla-policies')
  policies(@Ctx() ctx: RequestContext) {
    return this.admin.policies(ctx);
  }

  @RequirePermission('sla.manage')
  @Post('sla-policies')
  createPolicy(@Ctx() ctx: RequestContext, @Body(new ZodPipe(slaPolicySchema)) b: z.infer<typeof slaPolicySchema>) {
    return this.admin.createPolicy(ctx, b);
  }

  @RequirePermission('sla.manage')
  @Put('sla-policies/:id')
  updatePolicy(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(slaPolicySchema)) b: z.infer<typeof slaPolicySchema>) {
    return this.admin.updatePolicy(ctx, id, b);
  }

  @RequirePermission('sla.manage')
  @Delete('sla-policies/:id')
  @HttpCode(204)
  deletePolicy(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.admin.deletePolicy(ctx, id);
  }
}
