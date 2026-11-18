import { Controller, Get, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Ctx, RequirePermission } from '../common/decorators';
import type { RequestContext } from '../common/request-context';
import { SessionService } from '../auth/session.service';
import { cookieNames } from '../common/http';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { Inject } from '@nestjs/common';
import { EventsHub } from './events.service';

@Controller('events')
export class EventsController {
  constructor(
    private readonly hub: EventsHub,
    private readonly sessions: SessionService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  /** Server-Sent Events: `thread.updated` with ids the caller may see; `session.ended` when signed out. */
  @RequirePermission('conversation.read')
  @Get()
  async stream(@Ctx() ctx: RequestContext, @Req() req: Request, @Res() res: Response) {
    const token = req.cookies?.[cookieNames(this.cfg).session] as string | undefined;
    await this.hub.subscribe(ctx, res, async () => (await this.sessions.validate(token, { touch: false }))?.id === ctx.sessionId);
  }
}
