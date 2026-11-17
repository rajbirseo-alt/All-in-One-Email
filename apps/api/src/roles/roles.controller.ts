import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import { createRoleSchema, rolePermissionsSchema, updateRoleSchema } from '@crm/shared';
import type { z } from 'zod';
import { Ctx, RequirePermission } from '../common/decorators';
import type { RequestContext } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { RolesService } from './roles.service';

@Controller()
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @RequirePermission('role.manage')
  @Get('permissions')
  catalogue() {
    return this.roles.catalogue();
  }

  /** user.manage needs the list to pick a role when inviting. */
  @RequirePermission('role.manage', 'user.manage')
  @Get('roles')
  list() {
    return this.roles.list();
  }

  @RequirePermission('role.manage')
  @Post('roles')
  create(@Ctx() ctx: RequestContext, @Body(new ZodPipe(createRoleSchema)) body: z.infer<typeof createRoleSchema>) {
    return this.roles.create(ctx, body);
  }

  @RequirePermission('role.manage')
  @Patch('roles/:id')
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(updateRoleSchema)) body: z.infer<typeof updateRoleSchema>) {
    return this.roles.update(ctx, id, body);
  }

  @RequirePermission('role.manage')
  @Delete('roles/:id')
  @HttpCode(204)
  async remove(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    await this.roles.remove(ctx, id);
  }

  @RequirePermission('role.manage')
  @Put('roles/:id/permissions')
  setPermissions(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body(new ZodPipe(rolePermissionsSchema)) body: z.infer<typeof rolePermissionsSchema>,
  ) {
    return this.roles.setPermissions(ctx, id, body);
  }
}
