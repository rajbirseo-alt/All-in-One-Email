import type { Participant } from '@crm/shared';
import { htmlText } from '../assignment/routing.service';
import type { PrismaService } from '../prisma/prisma.service';

const PER_MESSAGE = 3000;
const TOTAL = 16_000;
const MAX_MESSAGES = 8;

/** Drops quoted history ("> …", "On … wrote:", Outlook's "From: … Sent: …") so each message counts once. */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r/g, '').split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^\s*>/.test(l)) continue;
    if (/^\s*On .{5,200}wrote:\s*$/i.test(l)) break;
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(l)) break;
    if (/^\s*From:\s.+/i.test(l) && lines.slice(i + 1, i + 5).some((n) => /^\s*(Sent|Date):\s/i.test(n))) break;
    out.push(l);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const who = (p: { address: string; name?: string | null }) => (p.name ? `${p.name} <${p.address}>` : p.address);

/**
 * The conversation as plain text for the AI: the latest messages, oldest first, each with who
 * wrote it and when. Only email content: internal notes, tags, assignees and CRM data are never
 * included.
 */
export async function conversationText(prisma: PrismaService, threadId: string) {
  const msgs = (
    await prisma.emailMessage.findMany({
      where: { threadId },
      orderBy: { receivedAt: 'desc' },
      take: MAX_MESSAGES,
      select: { id: true, direction: true, fromAddress: true, fromName: true, toRecipients: true, subject: true, bodyText: true, bodyHtml: true, snippet: true, receivedAt: true },
    })
  ).reverse();
  const thread = await prisma.emailThread.findUniqueOrThrow({ where: { id: threadId }, select: { subject: true, emailAccount: { select: { emailAddress: true, displayName: true } } } });
  let budget = TOTAL;
  const parts: string[] = [];
  for (const m of [...msgs].reverse()) {
    // Newest first for the budget, so the latest messages are always complete.
    const body = stripQuoted(m.bodyText ?? htmlText(m.bodyHtml ?? '') ?? m.snippet ?? '').slice(0, PER_MESSAGE);
    const to = Array.isArray(m.toRecipients) ? (m.toRecipients as unknown as Participant[]).map(who).join(', ') : '';
    const block = `--- ${m.direction === 'OUTBOUND' ? 'WE WROTE' : 'THEY WROTE'} · ${m.receivedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC\nFrom: ${who({ address: m.fromAddress, name: m.fromName })}\nTo: ${to}\nSubject: ${m.subject}\n\n${body}`;
    if (block.length > budget) break;
    budget -= block.length;
    parts.unshift(block);
  }
  return {
    latestMessageId: msgs.at(-1)?.id ?? null,
    lastInbound: [...msgs].reverse().find((m) => m.direction === 'INBOUND') ?? null,
    mailbox: thread.emailAccount,
    text: `Conversation subject: ${thread.subject}\nOur mailbox: ${who({ address: thread.emailAccount.emailAddress, name: thread.emailAccount.displayName })}\n\n${parts.join('\n\n')}`,
  };
}
