import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import {
  connectMailboxSchema,
  mailboxAccessSchema,
  mailboxFoldersSchema,
  mailboxSyncQuery,
  updateMailboxSchema,
  type MailboxDetail,
  type MailboxProvidersResponse,
  type MailboxSummary,
} from '@crm/shared';
import { Authenticated, Ctx, RequirePermission } from '../common/decorators';
import { Errors } from '../common/errors';
import { baseCookie, clearCookie, cookieNames } from '../common/http';
import type { AuthedRequest, RequestContext } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { ConnectError, MAILBOX_PROVIDER_PARAM, MailboxConnectService } from './mailbox-connect.service';
import { MailboxService } from './mailbox.service';

@Controller('accounts')
export class MailboxController {
  constructor(
    private readonly mailboxes: MailboxService,
    private readonly connect: MailboxConnectService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  @Authenticated()
  @Get()
  list(@Ctx() ctx: RequestContext): Promise<MailboxSummary[]> {
    return this.mailboxes.list(ctx);
  }

  @RequirePermission('account.connect', 'account.manage')
  @Get('providers')
  providers(): MailboxProvidersResponse {
    return this.mailboxes.providers();
  }

  /** Returns the provider consent URL; the browser navigates there. */
  @RequirePermission('account.connect')
  @Post('oauth/:provider/start')
  @HttpCode(200)
  async start(
    @Ctx() ctx: RequestContext,
    @Param('provider') raw: string,
    @Body(new ZodPipe(connectMailboxSchema)) body: z.infer<typeof connectMailboxSchema>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const provider = MAILBOX_PROVIDER_PARAM[raw];
    if (!provider) throw Errors.notFound('Mailbox provider');
    const { url, stateCookie } = await this.connect.start(ctx, provider, body);
    res.cookie(cookieNames(this.cfg).mailOauth, stateCookie, baseCookie(this.cfg, { httpOnly: true, maxAge: 10 * 60_000 }));
    return { url };
  }

  /** Provider redirects here (top-level GET, so the session cookie is sent). */
  @RequirePermission('account.connect')
  @Get('oauth/:provider/callback')
  async callback(
    @Param('provider') raw: string,
    @Query() query: { code?: string; state?: string; error?: string },
    @Req() req: AuthedRequest,
    @Res() res: Response,
  ) {
    const names = cookieNames(this.cfg);
    const stateCookie = (req as Request).cookies?.[names.mailOauth] as string | undefined;
    clearCookie(res, this.cfg, names.mailOauth);
    const page = `${this.cfg.appOrigin}/admin/mailboxes`;
    const provider = MAILBOX_PROVIDER_PARAM[raw];
    if (!provider) return res.redirect(302, `${page}?error=provider_disabled`);
    try {
      const id = await this.connect.complete(req.ctx!, provider, query, stateCookie);
      return res.redirect(302, `${page}?connected=${encodeURIComponent(id)}`);
    } catch (e) {
      if (e instanceof ConnectError) return res.redirect(302, `${page}?error=${encodeURIComponent(e.code)}`);
      throw e;
    }
  }

  @RequirePermission('account.manage')
  @Get(':id')
  detail(@Param('id') id: string): Promise<MailboxDetail> {
    return this.mailboxes.detail(id);
  }

  @RequirePermission('account.manage')
  @Patch(':id')
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(updateMailboxSchema)) body: z.infer<typeof updateMailboxSchema>) {
    return this.mailboxes.update(ctx, id, body);
  }

  @RequirePermission('account.manage')
  @Put(':id/folders')
  folders(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(mailboxFoldersSchema)) body: z.infer<typeof mailboxFoldersSchema>) {
    return this.mailboxes.setFolders(ctx, id, body);
  }

  @RequirePermission('account.manage')
  @Post(':id/sync')
  @HttpCode(202)
  async sync(@Ctx() ctx: RequestContext, @Param('id') id: string, @Query(new ZodPipe(mailboxSyncQuery)) q: z.infer<typeof mailboxSyncQuery>) {
    await this.mailboxes.syncNow(ctx, id, q.full === 'true');
    return { status: 'QUEUED' };
  }

  @RequirePermission('account.manage')
  @Post(':id/pause')
  @HttpCode(204)
  pause(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.mailboxes.pause(ctx, id);
  }

  @RequirePermission('account.manage')
  @Post(':id/resume')
  @HttpCode(204)
  resume(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.mailboxes.resume(ctx, id);
  }

  @RequirePermission('account.manage')
  @Delete(':id')
  disconnect(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.mailboxes.disconnect(ctx, id);
  }

  @RequirePermission('account.manage')
  @Put(':id/access')
  access(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(mailboxAccessSchema)) body: z.infer<typeof mailboxAccessSchema>) {
    return this.mailboxes.setAccess(ctx, id, body);
  }
}
