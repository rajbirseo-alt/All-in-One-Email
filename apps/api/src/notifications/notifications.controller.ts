import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import type { z } from 'zod';
import { notificationListQuery, notificationPrefsSchema, pushSubscriptionSchema, pushUnsubscribeSchema } from '@crm/shared';
import { Authenticated, Ctx } from '../common/decorators';
import type { RequestContext } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { NotificationsService } from './notifications.service';

/** Every employee's own notifications, preferences and devices (always scoped to the caller). */
@Controller()
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  @Authenticated()
  @Get('notifications')
  list(@Ctx() ctx: RequestContext, @Query(new ZodPipe(notificationListQuery)) q: z.infer<typeof notificationListQuery>) {
    return this.notifications.list(ctx, q);
  }

  @Authenticated()
  @Get('notifications/unread-count')
  async unread(@Ctx() ctx: RequestContext) {
    return { unread: await this.notifications.unreadCount(ctx) };
  }

  @Authenticated()
  @Post('notifications/read-all')
  @HttpCode(204)
  readAll(@Ctx() ctx: RequestContext) {
    return this.notifications.markAllRead(ctx);
  }

  @Authenticated()
  @Post('notifications/:id/read')
  @HttpCode(204)
  read(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.notifications.markRead(ctx, id);
  }

  @Authenticated()
  @Get('notification-preferences')
  prefs(@Ctx() ctx: RequestContext) {
    return this.notifications.preferences(ctx);
  }

  @Authenticated()
  @Put('notification-preferences')
  setPrefs(@Ctx() ctx: RequestContext, @Body(new ZodPipe(notificationPrefsSchema)) b: z.infer<typeof notificationPrefsSchema>) {
    return this.notifications.setPreferences(ctx, b.items);
  }

  /** The public VAPID key the browser needs to subscribe (null when push is not set up). */
  @Authenticated()
  @Get('push-subscriptions/config')
  pushConfig() {
    return { enabled: this.cfg.webPushEnabled, publicKey: this.cfg.webPushEnabled ? this.cfg.VAPID_PUBLIC_KEY! : null };
  }

  @Authenticated()
  @Get('push-subscriptions')
  devices(@Ctx() ctx: RequestContext) {
    return this.notifications.devices(ctx);
  }

  @Authenticated()
  @Post('push-subscriptions')
  @HttpCode(204)
  subscribe(@Ctx() ctx: RequestContext, @Body(new ZodPipe(pushSubscriptionSchema)) b: z.infer<typeof pushSubscriptionSchema>) {
    return this.notifications.subscribe(ctx, b, ctx.userAgent);
  }

  @Authenticated()
  @Delete('push-subscriptions')
  @HttpCode(204)
  unsubscribe(@Ctx() ctx: RequestContext, @Body(new ZodPipe(pushUnsubscribeSchema)) b: z.infer<typeof pushUnsubscribeSchema>) {
    return this.notifications.unsubscribe(ctx, b.endpoint);
  }
}
