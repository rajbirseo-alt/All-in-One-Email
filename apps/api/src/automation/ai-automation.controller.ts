import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { z } from 'zod';
import { automationRuleSchema, automationTestSchema, rewriteSchema, suggestReplySchema, type AiStatus } from '@crm/shared';
import { Authenticated, Ctx, RequirePermission } from '../common/decorators';
import type { RequestContext } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { InsightsService } from '../ai/insights.service';
import { SuggestionsService } from '../ai/suggestions.service';
import { AutomationService } from './automation.service';

/** AI calls cost money and time: at most this many per user per minute. */
const AI_LIMIT = { default: { limit: 20, ttl: 60_000 } };

/**
 * AI assistant and automation rules (docs/03 "AI & automation"). Nothing here sends email: AI
 * output becomes text or a DRAFT that its owner must send through the normal draft flow.
 */
@Controller()
export class AiAutomationController {
  constructor(
    private readonly insights: InsightsService,
    private readonly suggestions: SuggestionsService,
    private readonly automation: AutomationService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  @Authenticated()
  @Get('ai/status')
  status(): AiStatus {
    return { enabled: this.cfg.aiEnabled, model: this.cfg.aiEnabled ? this.cfg.OPENAI_MODEL : null, autoAnalyze: this.cfg.aiEnabled && this.cfg.AI_AUTO_ANALYZE };
  }

  @RequirePermission('ai.use')
  @Get('threads/:id/insights')
  getInsights(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.insights.get(ctx, id);
  }

  @RequirePermission('ai.use')
  @Throttle(AI_LIMIT)
  @Post('threads/:id/insights/refresh')
  @HttpCode(200)
  refreshInsights(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.insights.refresh(ctx, id);
  }

  @RequirePermission('ai.use')
  @Get('threads/:id/ai-suggestions')
  listSuggestions(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.suggestions.list(ctx, id);
  }

  @RequirePermission('ai.use')
  @Throttle(AI_LIMIT)
  @Post('ai/suggest-reply')
  suggest(@Ctx() ctx: RequestContext, @Body(new ZodPipe(suggestReplySchema)) b: z.infer<typeof suggestReplySchema>) {
    return this.suggestions.suggestReply(ctx, b);
  }

  /** Creates a DRAFT from the suggestion. There is deliberately no endpoint that sends a suggestion. */
  @RequirePermission('ai.use')
  @Post('ai/suggestions/:id/use')
  use(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.suggestions.use(ctx, id);
  }

  @RequirePermission('ai.use')
  @Post('ai/suggestions/:id/discard')
  @HttpCode(204)
  discard(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.suggestions.discard(ctx, id);
  }

  @RequirePermission('ai.use')
  @Throttle(AI_LIMIT)
  @Post('ai/rewrite')
  @HttpCode(200)
  rewrite(@Ctx() ctx: RequestContext, @Body(new ZodPipe(rewriteSchema)) b: z.infer<typeof rewriteSchema>) {
    return this.suggestions.rewrite(ctx, b);
  }

  // ───────────── automation rules ─────────────

  @RequirePermission('automation.manage')
  @Get('automation-rules')
  rules(@Ctx() ctx: RequestContext) {
    return this.automation.list(ctx);
  }

  @RequirePermission('automation.manage')
  @Post('automation-rules')
  create(@Ctx() ctx: RequestContext, @Body(new ZodPipe(automationRuleSchema)) b: z.infer<typeof automationRuleSchema>) {
    return this.automation.create(ctx, b);
  }

  @RequirePermission('automation.manage')
  @Put('automation-rules/:id')
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(automationRuleSchema)) b: z.infer<typeof automationRuleSchema>) {
    return this.automation.update(ctx, id, b);
  }

  @RequirePermission('automation.manage')
  @Delete('automation-rules/:id')
  @HttpCode(204)
  remove(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.automation.remove(ctx, id);
  }

  @RequirePermission('automation.manage')
  @Post('automation-rules/:id/enable')
  @HttpCode(200)
  enable(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.automation.setEnabled(ctx, id, true);
  }

  @RequirePermission('automation.manage')
  @Post('automation-rules/:id/disable')
  @HttpCode(200)
  disable(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.automation.setEnabled(ctx, id, false);
  }

  @RequirePermission('automation.manage')
  @Post('automation-rules/:id/test')
  @HttpCode(200)
  test(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(automationTestSchema)) b: z.infer<typeof automationTestSchema>) {
    return this.automation.test(ctx, id, b.threadId);
  }

  @RequirePermission('automation.manage')
  @Get('automation-rules/:id/runs')
  runs(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.automation.runs(ctx, id);
  }
}
