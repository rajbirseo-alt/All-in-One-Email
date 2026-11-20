import type { INestApplication } from '@nestjs/common';
import { expect } from 'vitest';
import type { FakeMail, GmailFakeMessage } from './fake-mail';
import { type Client, prisma } from './helpers';

let n = 0;
export const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);
export const uniqueMailbox = (p: string) => `${p}.${Date.now().toString(36)}${n++}@seodiscovery.test`;

export const MAIL_ENV = {
  GOOGLE_CLIENT_ID: 'g-client',
  GOOGLE_CLIENT_SECRET: 'g-secret',
  GMAIL_PUBSUB_TOPIC: 'projects/crm-test/topics/gmail-push',
  GMAIL_PUSH_SERVICE_ACCOUNT: 'gmail-push@crm-test.iam.gserviceaccount.com',
};

/** Connects a mailbox through the real OAuth endpoints (against the fake provider) and returns its id. */
export async function connectMailbox(admin: Client, fake: FakeMail, provider: 'google' | 'microsoft', box: string) {
  const start = await admin.post(`/accounts/oauth/${provider}/start`, { syncDays: 30 });
  expect(start.status).toBe(200);
  const state = new URL(start.body.url).searchParams.get('state')!;
  const code = fake.issueCode(provider === 'google' ? 'GMAIL' : 'MICROSOFT', box);
  const cb = await admin.get(`/accounts/oauth/${provider}/callback?code=${code}&state=${encodeURIComponent(state)}`);
  expect(cb.headers.location).toContain('connected=');
  return (await prisma.emailAccount.findUniqueOrThrow({ where: { emailAddress: box } })).id;
}

export function gmailMessage(box: string, id: string, over: Partial<GmailFakeMessage> = {}): GmailFakeMessage {
  return {
    id,
    threadId: `t-${id}`,
    labelIds: ['INBOX', 'UNREAD'],
    from: 'Client One <client@acme.com>',
    to: box,
    subject: `Subject ${id}`,
    text: `Body of ${id}`,
    date: daysAgo(2),
    messageId: `<${id}@acme.com>`,
    ...over,
  };
}

export type { INestApplication };

/** Worker-only services (send, flag push) built from the API app's providers, as the worker wires them. */
export async function workerServices(app: INestApplication) {
  const { SendService } = await import('../src/compose/send.service');
  const { FlagPushService } = await import('../src/mail/flag-push.service');
  const { AttachmentsService } = await import('../src/threads/attachments.service');
  const { SyncService } = await import('../src/mail/sync.service');
  const { IngestService } = await import('../src/mail/ingest.service');
  const { PrismaService } = await import('../src/prisma/prisma.service');
  const { AccessPolicy } = await import('../src/access/access-policy.service');
  const { CredentialService } = await import('../src/mail/credential.service');
  const { MAIL_ENDPOINTS } = await import('../src/mail/mail-endpoints');
  const prismaSvc = app.get(PrismaService);
  const sync = app.get(SyncService);
  const credentials = app.get(CredentialService);
  const attachments = new AttachmentsService(prismaSvc, app.get(AccessPolicy), sync, credentials);
  return {
    sender: new SendService(prismaSvc, sync, app.get(IngestService), attachments, credentials, app.get(MAIL_ENDPOINTS)),
    flags: new FlagPushService(prismaSvc, sync, credentials),
  };
}
