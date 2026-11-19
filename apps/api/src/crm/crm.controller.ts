import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import type { z } from 'zod';
import {
  companyListQuery,
  companySchema,
  contactCreateSchema,
  contactEmailSchema,
  contactFieldsSchema,
  contactListQuery,
  contactTagsSchema,
  dismissDuplicateSchema,
  leadCreateSchema,
  leadListQuery,
  leadStatusSchema,
  leadSummaryQuery,
  leadUpdateSchema,
  mergeSchema,
  taskCreateSchema,
  taskListQuery,
  taskUpdateSchema,
} from '@crm/shared';
import { Ctx, RequirePermission } from '../common/decorators';
import type { RequestContext } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { ContactsService } from './contacts.service';
import { LeadsService } from './leads.service';
import { TasksService } from './tasks.service';

/** Contacts, companies, leads and tasks (docs/03 "CRM & leads"). Every service call applies the caller's scope. */
@Controller()
export class CrmController {
  constructor(
    private readonly contacts: ContactsService,
    private readonly leads: LeadsService,
    private readonly tasks: TasksService,
  ) {}

  // ───────────── contacts (fixed paths before :id) ─────────────

  @RequirePermission('contact.read')
  @Get('contacts')
  listContacts(@Ctx() ctx: RequestContext, @Query(new ZodPipe(contactListQuery)) q: z.infer<typeof contactListQuery>) {
    return this.contacts.list(ctx, q);
  }

  @RequirePermission('contact.merge')
  @Get('contacts/duplicates')
  duplicates() {
    return this.contacts.duplicates();
  }

  @RequirePermission('contact.merge')
  @Post('contacts/duplicates/dismiss')
  @HttpCode(204)
  dismiss(@Ctx() ctx: RequestContext, @Body(new ZodPipe(dismissDuplicateSchema)) b: z.infer<typeof dismissDuplicateSchema>) {
    return this.contacts.dismissDuplicate(ctx, b);
  }

  @RequirePermission('contact.write')
  @Get('contacts/owner-options')
  contactOwners(@Ctx() ctx: RequestContext) {
    return this.contacts.ownerOptions(ctx);
  }

  @RequirePermission('contact.write')
  @Post('contacts')
  createContact(@Ctx() ctx: RequestContext, @Body(new ZodPipe(contactCreateSchema)) b: z.infer<typeof contactCreateSchema>) {
    return this.contacts.create(ctx, b);
  }

  @RequirePermission('contact.read')
  @Get('contacts/:id')
  contact(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.contacts.get(ctx, id);
  }

  @RequirePermission('contact.read')
  @Get('contacts/:id/timeline')
  timeline(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.contacts.timeline(ctx, id);
  }

  @RequirePermission('contact.write')
  @Put('contacts/:id')
  updateContact(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(contactFieldsSchema)) b: z.infer<typeof contactFieldsSchema>) {
    return this.contacts.update(ctx, id, b);
  }

  @RequirePermission('contact.write')
  @Post('contacts/:id/emails')
  addEmail(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(contactEmailSchema)) b: z.infer<typeof contactEmailSchema>) {
    return this.contacts.addEmail(ctx, id, b);
  }

  @RequirePermission('contact.write')
  @Delete('contacts/:id/emails/:emailId')
  removeEmail(@Ctx() ctx: RequestContext, @Param('id') id: string, @Param('emailId') emailId: string) {
    return this.contacts.removeEmail(ctx, id, emailId);
  }

  @RequirePermission('contact.write')
  @Post('contacts/:id/emails/:emailId/primary')
  primaryEmail(@Ctx() ctx: RequestContext, @Param('id') id: string, @Param('emailId') emailId: string) {
    return this.contacts.setPrimaryEmail(ctx, id, emailId);
  }

  @RequirePermission('contact.write')
  @Put('contacts/:id/tags')
  contactTags(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(contactTagsSchema)) b: z.infer<typeof contactTagsSchema>) {
    return this.contacts.setTags(ctx, id, b.tagIds);
  }

  @RequirePermission('contact.merge')
  @Post('contacts/:id/merge')
  merge(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(mergeSchema)) b: z.infer<typeof mergeSchema>, @Query('dryRun') dryRun?: string) {
    return this.contacts.merge(ctx, id, { ...b, dryRun: b.dryRun || dryRun === 'true' });
  }

  @RequirePermission('contact.merge')
  @Post('contact-merges/:id/undo')
  undoMerge(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.contacts.undoMerge(ctx, id);
  }

  // ───────────── companies ─────────────

  @RequirePermission('contact.read')
  @Get('companies')
  companies(@Ctx() ctx: RequestContext, @Query(new ZodPipe(companyListQuery)) q: z.infer<typeof companyListQuery>) {
    return this.contacts.companies(ctx, q);
  }

  @RequirePermission('contact.write')
  @Post('companies')
  createCompany(@Ctx() ctx: RequestContext, @Body(new ZodPipe(companySchema)) b: z.infer<typeof companySchema>) {
    return this.contacts.createCompany(ctx, b);
  }

  @RequirePermission('contact.read')
  @Get('companies/:id')
  company(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.contacts.company(ctx, id);
  }

  @RequirePermission('contact.write')
  @Put('companies/:id')
  updateCompany(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(companySchema)) b: z.infer<typeof companySchema>) {
    return this.contacts.updateCompany(ctx, id, b);
  }

  // ───────────── leads ─────────────

  @RequirePermission('lead.read')
  @Get('leads')
  listLeads(@Ctx() ctx: RequestContext, @Query(new ZodPipe(leadListQuery)) q: z.infer<typeof leadListQuery>) {
    return this.leads.list(ctx, q);
  }

  @RequirePermission('lead.read')
  @Get('leads/summary')
  leadSummary(@Ctx() ctx: RequestContext, @Query(new ZodPipe(leadSummaryQuery)) q: z.infer<typeof leadSummaryQuery>) {
    return this.leads.summary(ctx, q);
  }

  @RequirePermission('lead.write')
  @Get('leads/owner-options')
  leadOwners(@Ctx() ctx: RequestContext) {
    return this.leads.ownerOptions(ctx);
  }

  @RequirePermission('lead.write')
  @Post('leads')
  createLead(@Ctx() ctx: RequestContext, @Body(new ZodPipe(leadCreateSchema)) b: z.infer<typeof leadCreateSchema>) {
    return this.leads.create(ctx, b);
  }

  @RequirePermission('lead.read')
  @Get('leads/:id')
  lead(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.leads.get(ctx, id);
  }

  @RequirePermission('lead.write')
  @Put('leads/:id')
  updateLead(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(leadUpdateSchema)) b: z.infer<typeof leadUpdateSchema>) {
    return this.leads.update(ctx, id, b);
  }

  @RequirePermission('lead.write')
  @Post('leads/:id/status')
  leadStatus(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(leadStatusSchema)) b: z.infer<typeof leadStatusSchema>) {
    return this.leads.setStatus(ctx, id, b);
  }

  // ───────────── tasks ─────────────

  @RequirePermission('task.read')
  @Get('tasks')
  listTasks(@Ctx() ctx: RequestContext, @Query(new ZodPipe(taskListQuery)) q: z.infer<typeof taskListQuery>) {
    return this.tasks.list(ctx, q);
  }

  @RequirePermission('task.write')
  @Get('tasks/assignee-options')
  taskAssignees(@Ctx() ctx: RequestContext) {
    return this.tasks.assigneeOptions(ctx);
  }

  @RequirePermission('task.write')
  @Post('tasks')
  createTask(@Ctx() ctx: RequestContext, @Body(new ZodPipe(taskCreateSchema)) b: z.infer<typeof taskCreateSchema>) {
    return this.tasks.create(ctx, b);
  }

  @RequirePermission('task.read')
  @Get('tasks/:id')
  task(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.tasks.get(ctx, id);
  }

  @RequirePermission('task.write')
  @Put('tasks/:id')
  updateTask(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(taskUpdateSchema)) b: z.infer<typeof taskUpdateSchema>) {
    return this.tasks.update(ctx, id, b);
  }

  @RequirePermission('task.write')
  @Post('tasks/:id/complete')
  complete(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.tasks.setStatus(ctx, id, 'DONE');
  }

  @RequirePermission('task.write')
  @Post('tasks/:id/reopen')
  reopen(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.tasks.setStatus(ctx, id, 'OPEN');
  }

  @RequirePermission('task.write')
  @Post('tasks/:id/cancel')
  cancel(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.tasks.setStatus(ctx, id, 'CANCELLED');
  }

  // ───────────── the conversation's CRM panel ─────────────

  @RequirePermission('conversation.read')
  @Get('threads/:id/crm')
  threadCrm(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.contacts.forThread(ctx, id);
  }
}
