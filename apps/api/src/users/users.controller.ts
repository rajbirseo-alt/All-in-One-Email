import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import {
  absenceSchema,
  createUserSchema,
  listUsersQuery,
  permissionOverridesSchema,
  updateSelfSchema,
  updateUserSchema,
} from '@crm/shared';
import type { z } from 'zod';
import { Authenticated, Ctx, RequirePermission } from '../common/decorators';
import { Errors } from '../common/errors';
import type { RequestContext } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { PermissionService } from '../access/permission.service';
import { AuthService } from '../auth/auth.service';
import { UsersService } from './users.service';

@Controller()
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly auth: AuthService,
    private readonly perms: PermissionService,
  ) {}

  @RequirePermission('user.read')
  @Get('users')
  list(@Ctx() ctx: RequestContext, @Query(new ZodPipe(listUsersQuery)) q: z.infer<typeof listUsersQuery>) {
    return this.users.list(ctx, q);
  }

  @RequirePermission('user.read')
  @Get('users/:id')
  get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.users.get(ctx, id);
  }

  @RequirePermission('user.manage')
  @Post('users')
  create(@Ctx() ctx: RequestContext, @Body(new ZodPipe(createUserSchema)) body: z.infer<typeof createUserSchema>) {
    return this.users.create(ctx, body);
  }

  @RequirePermission('user.manage')
  @Patch('users/:id')
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(updateUserSchema)) body: z.infer<typeof updateUserSchema>) {
    return this.users.update(ctx, id, body);
  }

  @RequirePermission('user.manage')
  @Post('users/:id/suspend')
  @HttpCode(200)
  suspend(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.users.setStatus(ctx, id, 'suspend');
  }

  @RequirePermission('user.manage')
  @Post('users/:id/reactivate')
  @HttpCode(200)
  reactivate(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.users.setStatus(ctx, id, 'reactivate');
  }

  @RequirePermission('user.manage')
  @Post('users/:id/password-link')
  @HttpCode(200)
  passwordLink(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.auth.createPasswordLink(ctx, id);
  }

  @RequirePermission('user.manage')
  @Post('users/:id/mfa/reset')
  @HttpCode(204)
  async resetMfa(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    await this.users.resetMfa(ctx, id);
  }

  /** Self, or user.manage (checked in the service). */
  @Authenticated()
  @Put('users/:id/absence')
  absence(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(absenceSchema)) body: z.infer<typeof absenceSchema>) {
    return this.users.setAbsence(ctx, id, body);
  }

  @RequirePermission('role.manage')
  @Get('users/:id/permission-overrides')
  getOverrides(@Param('id') id: string) {
    return this.users.getOverrides(id);
  }

  @RequirePermission('role.manage')
  @Put('users/:id/permission-overrides')
  setOverrides(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body(new ZodPipe(permissionOverridesSchema)) body: z.infer<typeof permissionOverridesSchema>,
  ) {
    return this.users.setOverrides(ctx, id, body);
  }

  /** Self, or role.manage. */
  @Authenticated()
  @Get('users/:id/effective-permissions')
  async effective(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    if (id !== ctx.userId && !ctx.permissions['role.manage']) throw Errors.forbidden();
    try {
      return await this.perms.effectiveFor(id);
    } catch {
      throw Errors.notFound('Employee');
    }
  }

  @Authenticated()
  @Patch('me')
  updateSelf(@Ctx() ctx: RequestContext, @Body(new ZodPipe(updateSelfSchema)) body: z.infer<typeof updateSelfSchema>) {
    return this.users.updateSelf(ctx, body);
  }
}
