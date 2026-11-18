import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { z } from 'zod';
import { createDraftSchema, sendDraftSchema, signatureSchema, templateSchema, updateDraftSchema } from '@crm/shared';
import { Ctx, RequirePermission } from '../common/decorators';
import { Errors } from '../common/errors';
import type { RequestContext } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { DraftsService, MAX_OUTGOING_ATTACHMENTS } from './drafts.service';
import { SignaturesService, TemplatesService } from './library.service';

interface UploadedFileLike {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
}

@Controller()
export class ComposeController {
  constructor(
    private readonly drafts: DraftsService,
    private readonly signatures: SignaturesService,
    private readonly templates: TemplatesService,
  ) {}

  @RequirePermission('conversation.reply')
  @Post('drafts')
  create(@Ctx() ctx: RequestContext, @Body(new ZodPipe(createDraftSchema)) body: z.infer<typeof createDraftSchema>) {
    return this.drafts.create(ctx, body);
  }

  @RequirePermission('conversation.reply')
  @Get('drafts')
  list(@Ctx() ctx: RequestContext, @Query('threadId') threadId?: string) {
    return this.drafts.list(ctx, threadId);
  }

  @RequirePermission('conversation.reply')
  @Get('drafts/:id')
  get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.drafts.get(ctx, id);
  }

  /** Autosave (debounced by the client). */
  @RequirePermission('conversation.reply')
  @Patch('drafts/:id')
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(updateDraftSchema)) body: z.infer<typeof updateDraftSchema>) {
    return this.drafts.update(ctx, id, body);
  }

  @RequirePermission('conversation.reply')
  @Delete('drafts/:id')
  @HttpCode(204)
  remove(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.drafts.remove(ctx, id);
  }

  @RequirePermission('conversation.reply')
  @Post('drafts/:id/attachments')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_OUTGOING_ATTACHMENTS, files: 1 } }))
  upload(@Ctx() ctx: RequestContext, @Param('id') id: string, @UploadedFile() file: UploadedFileLike | undefined) {
    if (!file) throw Errors.validation([{ path: 'file', message: 'Choose a file' }]);
    return this.drafts.addAttachment(ctx, id, file);
  }

  @RequirePermission('conversation.reply')
  @Delete('drafts/:id/attachments/:attachmentId')
  removeAttachment(@Ctx() ctx: RequestContext, @Param('id') id: string, @Param('attachmentId') attachmentId: string) {
    return this.drafts.removeAttachment(ctx, id, attachmentId);
  }

  /** The explicit human send. 202: queued; 409 THREAD_CHANGED when new mail arrived meanwhile. */
  @RequirePermission('conversation.reply')
  @Post('drafts/:id/send')
  @HttpCode(202)
  send(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(sendDraftSchema)) body: z.infer<typeof sendDraftSchema>) {
    return this.drafts.send(ctx, id, body);
  }

  @RequirePermission('conversation.reply')
  @Post('drafts/:id/cancel-send')
  cancelSend(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.drafts.cancelSend(ctx, id);
  }

  // ── Signatures (own) ──
  @RequirePermission('conversation.reply')
  @Get('signatures')
  listSignatures(@Ctx() ctx: RequestContext) {
    return this.signatures.list(ctx);
  }

  @RequirePermission('conversation.reply')
  @Post('signatures')
  createSignature(@Ctx() ctx: RequestContext, @Body(new ZodPipe(signatureSchema)) body: z.infer<typeof signatureSchema>) {
    return this.signatures.save(ctx, null, body);
  }

  @RequirePermission('conversation.reply')
  @Patch('signatures/:id')
  updateSignature(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(signatureSchema)) body: z.infer<typeof signatureSchema>) {
    return this.signatures.save(ctx, id, body);
  }

  @RequirePermission('conversation.reply')
  @Delete('signatures/:id')
  @HttpCode(204)
  deleteSignature(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.signatures.remove(ctx, id);
  }

  // ── Templates ──
  @RequirePermission('conversation.reply')
  @Get('templates')
  listTemplates(@Ctx() ctx: RequestContext) {
    return this.templates.list(ctx);
  }

  @RequirePermission('conversation.reply')
  @Post('templates')
  createTemplate(@Ctx() ctx: RequestContext, @Body(new ZodPipe(templateSchema)) body: z.infer<typeof templateSchema>) {
    return this.templates.save(ctx, null, body);
  }

  @RequirePermission('conversation.reply')
  @Patch('templates/:id')
  updateTemplate(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(templateSchema)) body: z.infer<typeof templateSchema>) {
    return this.templates.save(ctx, id, body);
  }

  @RequirePermission('conversation.reply')
  @Delete('templates/:id')
  @HttpCode(204)
  deleteTemplate(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.templates.remove(ctx, id);
  }
}
