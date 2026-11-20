import { Inject, Injectable } from '@nestjs/common';
import type { AiInsightKind, Prisma } from '@crm/db';
import { newId } from '@crm/crypto';
import { AI_CATEGORIES, AI_SENTIMENTS, AI_URGENCIES, type ThreadInsights } from '@crm/shared';
import { AccessPolicy } from '../access/access-policy.service';
import { Errors } from '../common/errors';
import type { RequestContext } from '../common/request-context';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../prisma/prisma.service';
import { conversationText } from './conversation-text';
import { AiError, OpenAiClient, UNTRUSTED_NOTICE } from './openai.client';

interface InsightAnswer {
  summary: string;
  category: (typeof AI_CATEGORIES)[number];
  sentiment: (typeof AI_SENTIMENTS)[number];
  urgency: { level: (typeof AI_URGENCIES)[number]; reason: string };
  lead: { isLead: boolean; confidence: number; serviceInterest: string | null; companyName: string | null; reason: string };
  followUp: { needed: boolean; inDays: number | null; action: string | null };
}

const nullableString = { type: ['string', 'null'] };
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'category', 'sentiment', 'urgency', 'lead', 'followUp'],
  properties: {
    summary: { type: 'string', description: '2 to 4 plain sentences: who wants what, and what is still open' },
    category: { type: 'string', enum: [...AI_CATEGORIES] },
    sentiment: { type: 'string', enum: [...AI_SENTIMENTS], description: 'Of the other party, in their latest message' },
    urgency: {
      type: 'object',
      additionalProperties: false,
      required: ['level', 'reason'],
      properties: { level: { type: 'string', enum: [...AI_URGENCIES] }, reason: { type: 'string' } },
    },
    lead: {
      type: 'object',
      additionalProperties: false,
      required: ['isLead', 'confidence', 'serviceInterest', 'companyName', 'reason'],
      properties: {
        isLead: { type: 'boolean', description: 'A new business enquiry from a potential client (not an existing client, vendor, job seeker or newsletter)' },
        confidence: { type: 'number', description: '0 to 1' },
        serviceInterest: { ...nullableString, description: 'e.g. SEO, PPC, Social media, Web design' },
        companyName: nullableString,
        reason: { type: 'string' },
      },
    },
    followUp: {
      type: 'object',
      additionalProperties: false,
      required: ['needed', 'inDays', 'action'],
      properties: { needed: { type: 'boolean' }, inDays: { type: ['integer', 'null'] }, action: nullableString },
    },
  },
};

const KINDS: AiInsightKind[] = ['SUMMARY', 'CATEGORY', 'SENTIMENT', 'URGENCY', 'LEAD_DETECTION', 'FOLLOW_UP'];
/** A lead detection at or above this confidence fires the LEAD_DETECTED automation trigger. */
export const LEAD_CONFIDENCE = 0.7;

/**
 * Conversation insights, cached per latest message (a newer message makes them stale). Only
 * the mail itself is sent to the AI provider, and never for a mailbox with AI switched off.
 */
@Injectable()
export class InsightsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessPolicy,
    private readonly ai: OpenAiClient,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  /** Null when allowed; otherwise the reason. */
  async blockedReason(threadId: string): Promise<string | null> {
    if (!this.ai.enabled) return 'AI is not set up on the server';
    const t = await this.prisma.emailThread.findUnique({ where: { id: threadId }, select: { emailAccount: { select: { aiEnabled: true } } } });
    if (!t) return 'Conversation not found';
    return t.emailAccount.aiEnabled ? null : 'AI is switched off for this mailbox';
  }

  /** ai.use must cover the conversation (404 if unreadable, 403 if readable but outside the AI scope). */
  async assertUsable(ctx: RequestContext, threadId: string) {
    if (!ctx.permissions['ai.use']) throw Errors.forbidden('You cannot use the AI assistant');
    if (await this.prisma.emailThread.count({ where: { AND: [{ id: threadId }, await this.access.threadWhere(ctx, 'ai.use')] } })) return;
    const readable = ctx.permissions['conversation.read'] && (await this.prisma.emailThread.count({ where: { AND: [{ id: threadId }, await this.access.threadWhere(ctx)] } }));
    throw readable ? Errors.forbidden('You cannot use the AI assistant on this conversation') : Errors.notFound('Conversation');
  }

  async get(ctx: RequestContext, threadId: string): Promise<ThreadInsights> {
    await this.assertUsable(ctx, threadId);
    return this.view(threadId);
  }

  async refresh(ctx: RequestContext, threadId: string): Promise<ThreadInsights> {
    await this.assertUsable(ctx, threadId);
    try {
      await this.analyze(threadId, true);
    } catch (e) {
      throw e instanceof AiError ? e.toHttp() : e;
    }
    return this.view(threadId);
  }

  async view(threadId: string): Promise<ThreadInsights> {
    const reason = await this.blockedReason(threadId);
    const latest = await this.prisma.emailMessage.findFirst({ where: { threadId }, orderBy: { receivedAt: 'desc' }, select: { id: true } });
    const rows = await this.prisma.aiSummary.findMany({ where: { threadId }, orderBy: { createdAt: 'desc' }, take: 24 });
    const newest = rows[0];
    const of = (k: AiInsightKind) => rows.find((r) => r.kind === k && r.upToMessageId === newest?.upToMessageId)?.content as Record<string, unknown> | undefined;
    return {
      available: !reason,
      reason,
      stale: !!newest && !!latest && newest.upToMessageId !== latest.id,
      analyzedAt: newest?.createdAt.toISOString() ?? null,
      model: newest?.model ?? null,
      summary: (of('SUMMARY')?.text as string | undefined) ?? null,
      category: (of('CATEGORY')?.value as string | undefined) ?? null,
      sentiment: (of('SENTIMENT')?.value as string | undefined) ?? null,
      urgency: (of('URGENCY') as ThreadInsights['urgency'] | undefined) ?? null,
      lead: (of('LEAD_DETECTION') as ThreadInsights['lead'] | undefined) ?? null,
      followUp: (of('FOLLOW_UP') as ThreadInsights['followUp'] | undefined) ?? null,
    };
  }

  /**
   * Analyses the conversation up to its latest message, unless that is cached already (or
   * `force`). Returns the answer, or null when AI is off for it or there is nothing to analyse.
   */
  async analyze(threadId: string, force = false): Promise<InsightAnswer | null> {
    const blocked = await this.blockedReason(threadId);
    if (blocked) {
      if (force) throw new AiError(blocked.includes('mailbox') ? 'AI_NOT_ALLOWED' : 'AI_DISABLED', blocked);
      return null;
    }
    const conv = await conversationText(this.prisma, threadId);
    if (!conv.latestMessageId) return null;
    if (!force) {
      const cached = await this.prisma.aiSummary.findMany({ where: { threadId, upToMessageId: conv.latestMessageId } });
      if (cached.length >= KINDS.length) return this.fromRows(cached);
    }
    const r = await this.ai.structured<InsightAnswer>({
      name: 'thread_insights',
      schema: SCHEMA,
      system: `You analyse email conversations for the sales and support teams of a company. ${this.cfg.AI_COMPANY_CONTEXT} ${UNTRUSTED_NOTICE} Answer only with the requested JSON.`,
      user: conv.text,
      maxTokens: 900,
    });
    const a = r.data;
    a.lead.confidence = Math.max(0, Math.min(1, Number(a.lead.confidence) || 0));
    const content: Record<AiInsightKind, Prisma.InputJsonValue> = {
      SUMMARY: { text: String(a.summary).slice(0, 2000) },
      CATEGORY: { value: a.category },
      SENTIMENT: { value: a.sentiment },
      URGENCY: { level: a.urgency.level, reason: String(a.urgency.reason).slice(0, 500) },
      LEAD_DETECTION: { isLead: !!a.lead.isLead, confidence: a.lead.confidence, serviceInterest: a.lead.serviceInterest?.slice(0, 80) ?? null, companyName: a.lead.companyName?.slice(0, 200) ?? null, reason: String(a.lead.reason).slice(0, 500) },
      FOLLOW_UP: { needed: !!a.followUp.needed, inDays: a.followUp.inDays ?? null, action: a.followUp.action?.slice(0, 300) ?? null },
    };
    await this.prisma.$transaction([
      this.prisma.aiSummary.deleteMany({ where: { threadId, upToMessageId: conv.latestMessageId } }),
      this.prisma.aiSummary.createMany({
        data: KINDS.map((kind, i) => ({
          id: newId(),
          threadId,
          kind,
          model: r.model,
          content: content[kind],
          upToMessageId: conv.latestMessageId!,
          inputTokens: i === 0 ? r.inputTokens : null,
          outputTokens: i === 0 ? r.outputTokens : null,
        })),
      }),
    ]);
    return a;
  }

  private fromRows(rows: { kind: AiInsightKind; content: Prisma.JsonValue }[]): InsightAnswer {
    const c = (k: AiInsightKind) => (rows.find((r) => r.kind === k)?.content ?? {}) as Record<string, unknown>;
    return {
      summary: (c('SUMMARY').text as string) ?? '',
      category: c('CATEGORY').value as InsightAnswer['category'],
      sentiment: c('SENTIMENT').value as InsightAnswer['sentiment'],
      urgency: c('URGENCY') as InsightAnswer['urgency'],
      lead: c('LEAD_DETECTION') as InsightAnswer['lead'],
      followUp: c('FOLLOW_UP') as InsightAnswer['followUp'],
    };
  }

  /** Latest cached category / urgency / sentiment / lead for automation conditions (no AI call). */
  async facts(threadId: string) {
    const v = await this.view(threadId);
    return { category: v.category ?? '', urgency: v.urgency?.level ?? '', sentiment: v.sentiment ?? '', isLead: v.lead?.isLead ?? false, leadConfidence: v.lead?.confidence ?? 0, serviceInterest: v.lead?.serviceInterest ?? null };
  }
}
