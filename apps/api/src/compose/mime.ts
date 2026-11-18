import MailComposer from 'nodemailer/lib/mail-composer';
import type { Participant } from '@crm/shared';

export interface OutgoingMail {
  from: Participant;
  to: Participant[];
  cc: Participant[];
  bcc: Participant[];
  subject: string;
  html: string;
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  attachments: { filename: string; contentType: string; content: Buffer }[];
}

const addr = (p: Participant) => (p.name ? { name: p.name, address: p.address } : p.address);

/** Very small HTML → text for the text/plain alternative. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h\d)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Builds the RFC 5322 message. Only the draft's own fields are inputs: internal notes, AI
 * metadata or anything else about the thread can never end up in an outgoing email.
 * Bcc is kept in the raw message because Gmail reads recipients from the headers (and strips it).
 */
export async function buildMime(m: OutgoingMail): Promise<Buffer> {
  const composer = new MailComposer({
    from: addr(m.from),
    to: m.to.map(addr),
    cc: m.cc.map(addr),
    bcc: m.bcc.map(addr),
    subject: m.subject,
    html: m.html,
    text: htmlToText(m.html),
    messageId: m.messageId,
    ...(m.inReplyTo ? { inReplyTo: m.inReplyTo } : {}),
    ...(m.references.length ? { references: m.references } : {}),
    attachments: m.attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, content: a.content })),
  });
  const node = composer.compile();
  node.keepBcc = true;
  return node.build();
}
