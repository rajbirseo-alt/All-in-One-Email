import { CanActivate, ExecutionContext, Inject, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { safeEqual } from '@crm/crypto';
import { ACCESS_KEY, type AccessRule } from '../common/decorators';
import { Errors } from '../common/errors';
import { clientIp, cookieNames, userAgent } from '../common/http';
import type { AuthedRequest } from '../common/request-context';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PermissionService } from '../access/permission.service';
import { SessionService } from './session.service';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Global guard, in order:
 *  1. the route must declare an access rule (fail closed);
 *  2. state-changing requests from a browser must come from our own origin;
 *  3. non-public routes need a valid session and, when state-changing, a matching CSRF token;
 *  4. permission routes need at least one of the listed permissions.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly log = new Logger(AuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly permissions: PermissionService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const rule = this.reflector.getAllAndOverride<AccessRule | undefined>(ACCESS_KEY, [context.getHandler(), context.getClass()]);
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    if (!rule) {
      this.log.error(`Route ${req.method} ${req.path} has no access rule — denied`);
      throw Errors.forbidden();
    }

    const mutating = !SAFE_METHODS.has(req.method);
    if (mutating) {
      const origin = req.headers.origin;
      if (origin && origin !== this.cfg.appOrigin) throw Errors.csrf();
    }
    if (rule.kind === 'public') return true;

    const names = cookieNames(this.cfg);
    const session = await this.sessions.validate(req.cookies?.[names.session]);
    if (!session) throw Errors.unauthenticated();

    if (mutating) {
      const header = req.headers['x-csrf-token'];
      const cookie = req.cookies?.[names.csrf];
      if (typeof header !== 'string' || typeof cookie !== 'string' || !safeEqual(header, cookie)) throw Errors.csrf();
    }

    const permissions = await this.permissions.effectiveFor(session.userId);
    req.ctx = {
      userId: session.userId,
      sessionId: session.id,
      roleKey: session.user.roleKey,
      departmentId: session.user.departmentId,
      permissions,
      ip: clientIp(req),
      userAgent: userAgent(req),
    };

    if (rule.kind === 'permission' && !rule.anyOf.some((p) => permissions[p] !== undefined)) {
      throw Errors.forbidden();
    }
    return true;
  }
}
