import { Controller, Get, Header, Headers, Inject, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { safeEqual } from '@crm/crypto';
import { Public, RequirePermission } from '../common/decorators';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { SystemHealthService } from './system-health.service';

@Controller()
export class SystemController {
  constructor(
    private readonly health: SystemHealthService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  /** Admin → System health. */
  @RequirePermission('account.manage')
  @Get('system/health')
  check() {
    return this.health.run();
  }

  /**
   * Prometheus-format metrics for an external monitor (Grafana Cloud, Better Stack, …).
   * Off unless METRICS_TOKEN is set; the monitor sends `Authorization: Bearer <token>`.
   */
  @Public()
  @SkipThrottle()
  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  async metrics(@Headers('authorization') auth?: string) {
    if (!this.cfg.METRICS_TOKEN) throw new NotFoundException();
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token || !safeEqual(token, this.cfg.METRICS_TOKEN)) throw new UnauthorizedException();
    return this.health.prometheus(await this.health.run());
  }
}
