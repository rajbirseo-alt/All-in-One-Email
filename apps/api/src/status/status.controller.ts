import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import type { z } from 'zod';
import { prioritySchema, statusChangeSchema } from '@crm/shared';
import { Ctx, RequirePermission } from '../common/decorators';
import type { RequestContext } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { StatusService } from './status.service';

/** Registered before ThreadsController so threads/:id/status is not taken for a flag action. */
@Controller()
export class StatusController {
  constructor(private readonly status: StatusService) {}

  @RequirePermission('conversation.status')
  @Post('threads/:id/status')
  @HttpCode(204)
  change(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(statusChangeSchema)) b: z.infer<typeof statusChangeSchema>) {
    return this.status.change(ctx, id, b);
  }

  @RequirePermission('conversation.status')
  @Post('threads/:id/priority')
  @HttpCode(204)
  priority(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(prioritySchema)) b: z.infer<typeof prioritySchema>) {
    return this.status.setPriority(ctx, id, b.priority);
  }

  @RequirePermission('conversation.read')
  @Get('threads/:id/status-history')
  history(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.status.history(ctx, id);
  }
}
