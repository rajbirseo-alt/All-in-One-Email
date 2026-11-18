import { Body, Controller, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import { snoozeSchema, threadDetailQuery, threadListQuery, THREAD_ACTIONS, type ThreadCounts, type ThreadDetail } from '@crm/shared';
import { Errors } from '../common/errors';
import type { FlagAction } from '../mail/queue.service';
import { ThreadActionsService } from './thread-actions.service';
import { Ctx, RequirePermission } from '../common/decorators';
import type { RequestContext } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { AttachmentsService } from './attachments.service';
import { ThreadsService } from './threads.service';

@Controller()
export class ThreadsController {
  constructor(
    private readonly threads: ThreadsService,
    private readonly attachments: AttachmentsService,
    private readonly actions: ThreadActionsService,
  ) {}

  /** read · unread · star · unstar · archive · unarchive · spam · not-spam (archive/spam need conversation.status). */
  @RequirePermission('conversation.read')
  @Post('threads/:id/snooze')
  @HttpCode(204)
  snooze(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(snoozeSchema)) body: z.infer<typeof snoozeSchema>) {
    return this.actions.snooze(ctx, id, body.until);
  }

  @RequirePermission('conversation.read')
  @Post('threads/:id/:action')
  @HttpCode(204)
  act(@Ctx() ctx: RequestContext, @Param('id') id: string, @Param('action') action: string) {
    if (!(THREAD_ACTIONS as readonly string[]).includes(action)) throw Errors.notFound('Action');
    return this.actions.apply(ctx, id, action as FlagAction);
  }

  @RequirePermission('conversation.read')
  @Get('threads')
  list(@Ctx() ctx: RequestContext, @Query(new ZodPipe(threadListQuery)) q: z.infer<typeof threadListQuery>) {
    return this.threads.list(ctx, q);
  }

  /** Sidebar badges: unread counts for inbox/mine/unassigned, totals for the other views. */
  @RequirePermission('conversation.read')
  @Get('threads/counts')
  counts(@Ctx() ctx: RequestContext): Promise<ThreadCounts> {
    return this.threads.counts(ctx);
  }

  @RequirePermission('conversation.read')
  @Get('threads/:id')
  detail(@Ctx() ctx: RequestContext, @Param('id') id: string, @Query(new ZodPipe(threadDetailQuery)) q: z.infer<typeof threadDetailQuery>): Promise<ThreadDetail> {
    return this.threads.detail(ctx, id, q.images === 'true');
  }

  @RequirePermission('conversation.read')
  @Get('attachments/:id/download')
  async download(@Ctx() ctx: RequestContext, @Param('id') id: string, @Query('inline') inline: string | undefined, @Res() res: Response) {
    const file = await this.attachments.download(ctx, id, inline === '1');
    const ascii = file.filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    res.setHeader('Content-Type', file.inline ? file.contentType : 'application/octet-stream');
    res.setHeader('Content-Disposition', `${file.inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
    res.setHeader('Content-Length', String(file.data.length));
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(file.data);
  }
}
