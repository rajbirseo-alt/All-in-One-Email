import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import type { z } from 'zod';
import { assignSchema, assignmentRuleSchema, bulkSchema, noteSchema, presenceSchema, ruleOrderSchema, ruleTestSchema, shareSchema, tagSchema } from '@crm/shared';
import { Ctx, RequirePermission } from '../common/decorators';
import { Errors } from '../common/errors';
import type { RequestContext } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { EventsHub } from '../events/events.service';
import { PrismaService } from '../prisma/prisma.service';
import { ThreadsService } from '../threads/threads.service';
import { AssignmentService } from './assignment.service';
import { CollabService } from './collab.service';
import { RulesService } from './rules.service';

@Controller()
export class AssignmentController {
  constructor(
    private readonly assignment: AssignmentService,
    private readonly collab: CollabService,
    private readonly rules: RulesService,
    private readonly hub: EventsHub,
    private readonly threads: ThreadsService,
    private readonly prisma: PrismaService,
  ) {}

  // ── assignment ──
  @RequirePermission('conversation.assign')
  @Get('threads/:id/assignees')
  async assignees(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    await this.assignment.assignable(ctx, id);
    return this.assignment.options(ctx);
  }

  @RequirePermission('conversation.assign')
  @Post('threads/:id/assign')
  @HttpCode(204)
  assign(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(assignSchema)) b: z.infer<typeof assignSchema>) {
    return this.assignment.assignByUser(ctx, id, { assigneeId: b.assigneeId, teamId: b.teamId, departmentId: b.departmentId }, 'MANUAL', b.reason);
  }

  @RequirePermission('conversation.assign')
  @Post('threads/:id/unassign')
  @HttpCode(204)
  unassign(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.assignment.unassignByUser(ctx, id);
  }

  @RequirePermission('conversation.read')
  @Get('threads/:id/assignments')
  history(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.collab.history(ctx, id);
  }

  /** Bulk actions (max 500): assign, unassign, read, unread, archive, spam, star, tag, untag. */
  @RequirePermission('conversation.read')
  @Post('threads/bulk')
  @HttpCode(200)
  bulk(@Ctx() ctx: RequestContext, @Body(new ZodPipe(bulkSchema)) b: z.infer<typeof bulkSchema>) {
    return this.collab.bulk(ctx, b);
  }

  // ── notes ──
  @RequirePermission('conversation.read')
  @Get('threads/:id/notes')
  notes(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.collab.notes(ctx, id);
  }

  @RequirePermission('conversation.read')
  @Post('threads/:id/notes')
  addNote(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(noteSchema)) b: z.infer<typeof noteSchema>) {
    return this.collab.addNote(ctx, id, b.body);
  }

  @RequirePermission('conversation.read')
  @Patch('threads/:id/notes/:noteId')
  @HttpCode(204)
  editNote(@Ctx() ctx: RequestContext, @Param('id') id: string, @Param('noteId') noteId: string, @Body(new ZodPipe(noteSchema)) b: z.infer<typeof noteSchema>) {
    return this.collab.editNote(ctx, id, noteId, b.body);
  }

  @RequirePermission('conversation.read')
  @Delete('threads/:id/notes/:noteId')
  @HttpCode(204)
  deleteNote(@Ctx() ctx: RequestContext, @Param('id') id: string, @Param('noteId') noteId: string) {
    return this.collab.editNote(ctx, id, noteId, null);
  }

  // ── shares ──
  @RequirePermission('conversation.share')
  @Put('threads/:id/shares/:userId')
  @HttpCode(204)
  share(@Ctx() ctx: RequestContext, @Param('id') id: string, @Param('userId') userId: string, @Body(new ZodPipe(shareSchema)) b: z.infer<typeof shareSchema>) {
    return this.collab.share(ctx, id, userId, b.canReply);
  }

  @RequirePermission('conversation.share')
  @Delete('threads/:id/shares/:userId')
  @HttpCode(204)
  unshare(@Ctx() ctx: RequestContext, @Param('id') id: string, @Param('userId') userId: string) {
    return this.collab.share(ctx, id, userId, null);
  }

  // ── tags ──
  @RequirePermission('conversation.read')
  @Get('tags')
  tags() {
    return this.collab.tags();
  }

  @RequirePermission('rules.manage')
  @Post('tags')
  createTag(@Ctx() ctx: RequestContext, @Body(new ZodPipe(tagSchema)) b: z.infer<typeof tagSchema>) {
    return this.collab.saveTag(ctx, null, b);
  }

  @RequirePermission('rules.manage')
  @Patch('tags/:tagId')
  updateTag(@Ctx() ctx: RequestContext, @Param('tagId') tagId: string, @Body(new ZodPipe(tagSchema)) b: z.infer<typeof tagSchema>) {
    return this.collab.saveTag(ctx, tagId, b);
  }

  @RequirePermission('rules.manage')
  @Delete('tags/:tagId')
  @HttpCode(204)
  deleteTag(@Ctx() ctx: RequestContext, @Param('tagId') tagId: string) {
    return this.collab.deleteTag(ctx, tagId);
  }

  @RequirePermission('conversation.read')
  @Put('threads/:id/tags/:tagId')
  @HttpCode(204)
  tag(@Ctx() ctx: RequestContext, @Param('id') id: string, @Param('tagId') tagId: string) {
    return this.collab.setTag(ctx, id, tagId, true);
  }

  @RequirePermission('conversation.read')
  @Delete('threads/:id/tags/:tagId')
  @HttpCode(204)
  untag(@Ctx() ctx: RequestContext, @Param('id') id: string, @Param('tagId') tagId: string) {
    return this.collab.setTag(ctx, id, tagId, false);
  }

  // ── presence ──
  @RequirePermission('conversation.read')
  @Post('threads/:id/presence')
  @HttpCode(204)
  async presence(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(presenceSchema)) b: z.infer<typeof presenceSchema>) {
    await this.threads.findVisible(ctx, id);
    const me = await this.prisma.user.findUnique({ where: { id: ctx.userId }, select: { name: true } });
    if (!me) throw Errors.unauthenticated();
    await this.hub.publishPresence(id, ctx.userId, me.name, b.state);
  }

  // ── rules ──
  @RequirePermission('rules.manage')
  @Get('assignment-rules')
  listRules(@Ctx() ctx: RequestContext) {
    return this.rules.list(ctx);
  }

  @RequirePermission('rules.manage')
  @Post('assignment-rules')
  createRule(@Ctx() ctx: RequestContext, @Body(new ZodPipe(assignmentRuleSchema)) b: z.infer<typeof assignmentRuleSchema>) {
    return this.rules.create(ctx, b);
  }

  @RequirePermission('rules.manage')
  @Put('assignment-rules/order')
  reorder(@Ctx() ctx: RequestContext, @Body(new ZodPipe(ruleOrderSchema)) b: z.infer<typeof ruleOrderSchema>) {
    return this.rules.reorder(ctx, b.ids);
  }

  @RequirePermission('rules.manage')
  @Post('assignment-rules/test')
  @HttpCode(200)
  testRules(@Ctx() ctx: RequestContext, @Body(new ZodPipe(ruleTestSchema)) b: z.infer<typeof ruleTestSchema>) {
    return this.rules.test(ctx, b);
  }

  @RequirePermission('rules.manage')
  @Patch('assignment-rules/:ruleId')
  updateRule(@Ctx() ctx: RequestContext, @Param('ruleId') ruleId: string, @Body(new ZodPipe(assignmentRuleSchema)) b: z.infer<typeof assignmentRuleSchema>) {
    return this.rules.update(ctx, ruleId, b);
  }

  @RequirePermission('rules.manage')
  @Delete('assignment-rules/:ruleId')
  @HttpCode(204)
  deleteRule(@Ctx() ctx: RequestContext, @Param('ruleId') ruleId: string) {
    return this.rules.remove(ctx, ruleId);
  }
}
