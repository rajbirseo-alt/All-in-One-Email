import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import { createDepartmentSchema, createTeamSchema, teamMemberSchema, updateDepartmentSchema, updateTeamSchema } from '@crm/shared';
import type { z } from 'zod';
import { Ctx, RequirePermission } from '../common/decorators';
import type { RequestContext } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { OrgService } from './org.service';

@Controller()
export class OrgController {
  constructor(private readonly org: OrgService) {}

  @RequirePermission('user.read', 'org.manage')
  @Get('departments')
  list(@Ctx() ctx: RequestContext) {
    return this.org.listDepartments(ctx);
  }

  @RequirePermission('org.manage')
  @Post('departments')
  createDepartment(@Ctx() ctx: RequestContext, @Body(new ZodPipe(createDepartmentSchema)) body: z.infer<typeof createDepartmentSchema>) {
    return this.org.createDepartment(ctx, body);
  }

  @RequirePermission('org.manage')
  @Patch('departments/:id')
  updateDepartment(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body(new ZodPipe(updateDepartmentSchema)) body: z.infer<typeof updateDepartmentSchema>,
  ) {
    return this.org.updateDepartment(ctx, id, body);
  }

  @RequirePermission('org.manage')
  @Delete('departments/:id')
  @HttpCode(204)
  async deleteDepartment(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    await this.org.deleteDepartment(ctx, id);
  }

  @RequirePermission('org.manage')
  @Post('teams')
  createTeam(@Ctx() ctx: RequestContext, @Body(new ZodPipe(createTeamSchema)) body: z.infer<typeof createTeamSchema>) {
    return this.org.createTeam(ctx, body);
  }

  @RequirePermission('org.manage')
  @Patch('teams/:id')
  updateTeam(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(updateTeamSchema)) body: z.infer<typeof updateTeamSchema>) {
    return this.org.updateTeam(ctx, id, body);
  }

  @RequirePermission('org.manage')
  @Delete('teams/:id')
  @HttpCode(204)
  async deleteTeam(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    await this.org.deleteTeam(ctx, id);
  }

  @RequirePermission('org.manage')
  @Put('teams/:id/members')
  upsertMember(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(teamMemberSchema)) body: z.infer<typeof teamMemberSchema>) {
    return this.org.upsertMember(ctx, id, body);
  }

  @RequirePermission('org.manage')
  @Delete('teams/:id/members/:userId')
  removeMember(@Ctx() ctx: RequestContext, @Param('id') id: string, @Param('userId') userId: string) {
    return this.org.removeMember(ctx, id, userId);
  }
}
