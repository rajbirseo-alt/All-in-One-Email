import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  loginSchema,
  mfaEnrollStartSchema,
  mfaVerifySchema,
  setPasswordSchema,
  type AuthProvidersResponse,
  type MeResponse,
} from '@crm/shared';
import { z } from 'zod';
import type { Request, Response } from 'express';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../prisma/prisma.service';
import { Authenticated, Ctx, Public } from '../common/decorators';
import { Errors } from '../common/errors';
import { baseCookie, clearCookie, cookieNames } from '../common/http';
import type { RequestContext } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';
import { SsoError, SsoService, type SsoProviderId } from './sso.service';
import { LOGIN_THROTTLE } from './login-throttle';

const providerParam = z.enum(['google', 'microsoft']);
const codeOnly = z.object({ code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') });

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sso: SsoService,
    private readonly sessions: SessionService,
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  @Public()
  @Get('providers')
  providers(): AuthProvidersResponse {
    return { google: this.sso.enabled('google'), microsoft: this.sso.enabled('microsoft'), password: this.cfg.PASSWORD_LOGIN_ENABLED };
  }

  @Public()
  @Throttle(LOGIN_THROTTLE)
  @Post('login')
  @HttpCode(200)
  login(@Body(new ZodPipe(loginSchema)) body: z.infer<typeof loginSchema>, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.auth.passwordLogin(body.email, body.password, req, res);
  }

  @Public()
  @Throttle(LOGIN_THROTTLE)
  @Post('mfa/verify')
  @HttpCode(200)
  mfaVerify(@Body(new ZodPipe(mfaVerifySchema)) body: z.infer<typeof mfaVerifySchema>, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.auth.mfaVerify(body.mfaToken, body.code, req, res);
  }

  @Public()
  @Throttle(LOGIN_THROTTLE)
  @Post('mfa/enroll/start')
  @HttpCode(200)
  mfaEnrollStart(@Body(new ZodPipe(mfaEnrollStartSchema)) body: z.infer<typeof mfaEnrollStartSchema>) {
    return this.auth.mfaEnrollStart(body.mfaToken);
  }

  @Public()
  @Throttle(LOGIN_THROTTLE)
  @Post('mfa/enroll/confirm')
  @HttpCode(200)
  mfaEnrollConfirm(@Body(new ZodPipe(mfaVerifySchema)) body: z.infer<typeof mfaVerifySchema>, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.auth.mfaEnrollConfirm(body.mfaToken, body.code, req, res);
  }

  @Public()
  @Throttle(LOGIN_THROTTLE)
  @Post('password/set')
  @HttpCode(204)
  async setPassword(@Body(new ZodPipe(setPasswordSchema)) body: z.infer<typeof setPasswordSchema>, @Req() req: Request) {
    await this.auth.setPassword(body.token, body.password, req);
  }

  @Public()
  @Get('sso/:provider/start')
  ssoStart(@Param('provider') raw: string, @Res() res: Response) {
    const provider = providerParam.safeParse(raw);
    if (!provider.success || !this.sso.enabled(provider.data)) throw Errors.notFound('Sign-in provider');
    const { url, stateCookie } = this.sso.start(provider.data);
    res.cookie(cookieNames(this.cfg).oauth, stateCookie, baseCookie(this.cfg, { httpOnly: true, maxAge: 10 * 60_000 }));
    res.redirect(302, url);
  }

  @Public()
  @Get('sso/:provider/callback')
  async ssoCallback(
    @Param('provider') raw: string,
    @Query() query: { code?: string; state?: string; error?: string },
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const names = cookieNames(this.cfg);
    const stateCookie = req.cookies?.[names.oauth] as string | undefined;
    clearCookie(res, this.cfg, names.oauth);
    const fail = (code: string) => res.redirect(302, `${this.cfg.appOrigin}/login?error=${encodeURIComponent(code)}`);
    const provider = providerParam.safeParse(raw);
    if (!provider.success) return fail('provider_disabled');
    try {
      const claims = await this.sso.complete(provider.data as SsoProviderId, query, stateCookie);
      await this.auth.ssoLogin(provider.data, claims, req, res);
      return res.redirect(302, `${this.cfg.appOrigin}/`);
    } catch (e) {
      if (e instanceof SsoError) return fail(e.code);
      throw e;
    }
  }

  @Authenticated()
  @Post('logout')
  @HttpCode(204)
  async logout(@Ctx() ctx: RequestContext, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(ctx, res);
  }

  @Authenticated()
  @Get('me')
  async me(@Ctx() ctx: RequestContext, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<MeResponse> {
    if (!req.cookies?.[cookieNames(this.cfg).csrf]) this.sessions.issueCsrf(res);
    const [u, s] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: ctx.userId },
        include: { role: { select: { id: true, key: true, name: true } }, department: { select: { id: true, name: true } } },
      }),
      this.prisma.session.findUniqueOrThrow({ where: { id: ctx.sessionId } }),
    ]);
    return {
      user: {
        id: u.id,
        email: u.email,
        name: u.name,
        avatarUrl: u.avatarUrl,
        timezone: u.timezone,
        isAbsent: u.isAbsent,
        absentUntil: u.absentUntil?.toISOString() ?? null,
        mfaEnabled: !!u.mfaEnabledAt,
        role: u.role,
        department: u.department,
      },
      permissions: ctx.permissions,
      session: { id: s.id, authMethod: s.authMethod, expiresAt: s.expiresAt.toISOString() },
    };
  }

  @Authenticated()
  @Get('sessions')
  listSessions(@Ctx() ctx: RequestContext) {
    return this.auth.listSessions(ctx);
  }

  @Authenticated()
  @Delete('sessions/:id')
  @HttpCode(204)
  async revokeSession(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    await this.auth.revokeSession(ctx, id);
  }

  @Authenticated()
  @Post('mfa/self/start')
  @HttpCode(200)
  selfStart(@Ctx() ctx: RequestContext) {
    return this.auth.selfEnrollStart(ctx);
  }

  @Authenticated()
  @Post('mfa/self/confirm')
  @HttpCode(204)
  async selfConfirm(@Ctx() ctx: RequestContext, @Body(new ZodPipe(codeOnly)) body: z.infer<typeof codeOnly>) {
    await this.auth.selfEnrollConfirm(ctx, body.code);
  }

  @Authenticated()
  @Delete('mfa/self')
  @HttpCode(204)
  async selfDisable(@Ctx() ctx: RequestContext) {
    await this.auth.selfDisableMfa(ctx);
  }
}
