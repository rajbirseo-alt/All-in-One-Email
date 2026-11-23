import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SendService } from '../src/compose/send.service';
import { QUEUES, QueueService, type SendJob } from '../src/mail/queue.service';
import { RetentionService } from '../src/mail/retention.service';
import { AuditService } from '../src/audit/audit.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { FileStore } from '../src/storage/file-store.service';
import { SyncService } from '../src/mail/sync.service';
import { clamdScan } from '../src/storage/scanner';
import { S3Client } from '../src/storage/s3';
import { attachmentBytes, FakeMail } from './fake-mail';
import { EICAR, FakeClamd, FakeS3 } from './fake-storage';
import { bootApp, type Client, clientAs, makeUser, prisma } from './helpers';
import { connectMailbox, gmailMessage, MAIL_ENV, uniqueMailbox, workerServices } from './mail-helpers';

/**
 * Phase 10: virus scanning (clamd) and encrypted object storage (S3-compatible) for attachments.
 * Local stand-ins: a clamd speaking the INSTREAM protocol and an S3 that verifies SigV4.
 */
let fake: FakeMail;
let clamd: FakeClamd;
let s3: FakeS3;
let app: INestApplication;
let admin: Client;
let adminId: string;
let sync: SyncService;
let sender: SendService;
const box = uniqueMailbox('files');
let boxId: string;
const thread = (providerThreadId: string) => prisma.emailThread.findFirstOrThrow({ where: { providerThreadId } });
const attOf = async (providerThreadId: string) => prisma.attachment.findFirstOrThrow({ where: { message: { threadId: (await thread(providerThreadId)).id } } });

async function runSends(draftId: string) {
  const boss = await app.get(QueueService).get();
  const jobs = (await boss.findJobs<SendJob>(QUEUES.send, { queued: true })).filter((j) => j.data.draftId === draftId);
  const out: string[] = [];
  for (const j of jobs) {
    try {
      out.push(await sender.send(j.data));
    } catch (e) {
      out.push(`threw:${(e as Error).message}`);
    }
    await boss.deleteJob(QUEUES.send, j.id);
  }
  return out;
}

beforeAll(async () => {
  fake = await new FakeMail().start();
  clamd = await new FakeClamd().start();
  s3 = await new FakeS3().start();
  ({ app } = await bootApp({ mailEndpoints: fake.endpoints(), env: { ...MAIL_ENV, ...s3.env(), CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: String(clamd.port) } }));
  sync = app.get(SyncService);
  ({ sender } = await workerServices(app));
  adminId = (await makeUser({ role: 'SUPER_ADMIN' })).id;
  admin = await clientAs(app, adminId);
  fake.gmailAdd(box, gmailMessage(box, 'ok1', { subject: 'Clean brief', attachment: { filename: 'brief.pdf', mime: 'application/pdf', size: 40 } }));
  fake.gmailAdd(box, gmailMessage(box, 'bad1', { subject: 'Invoice', attachment: { filename: 'invoice.pdf', mime: 'application/pdf', size: 68, bytes: EICAR } }));
  boxId = await connectMailbox(admin, fake, 'google', box);
  await sync.run(boxId, 'INITIAL');
});

afterAll(async () => {
  await app?.close();
  fake?.stop();
  clamd?.stop();
  s3?.stop();
});

describe('Phase 10: virus scanning', () => {
  it('the clamd client speaks INSTREAM: clean, infected, and a scanner that is down', async () => {
    expect(await clamdScan('127.0.0.1', clamd.port, Buffer.from('hello'))).toEqual({ status: 'CLEAN' });
    expect(await clamdScan('127.0.0.1', clamd.port, Buffer.from(`prefix ${EICAR}`))).toEqual({ status: 'INFECTED', signature: 'Win.Test.EICAR_HDB-1' });
    // Larger than one 64 KB chunk.
    expect(await clamdScan('127.0.0.1', clamd.port, Buffer.concat([Buffer.alloc(200_000, 1), Buffer.from(EICAR)]))).toMatchObject({ status: 'INFECTED' });
    const closed = await clamdScan('127.0.0.1', 1, Buffer.from('x'), 2000);
    expect(closed.status).toBe('FAILED');
  });

  it('an infected upload is refused and stored nowhere; a clean one is scanned', async () => {
    const d = (await admin.post('/drafts', { mode: 'NEW', emailAccountId: boxId })).body;
    const objects = s3.objects.size;
    const bad = await admin.upload(`/drafts/${d.id}/attachments`, 'report.pdf', Buffer.from(EICAR));
    expect(bad.status).toBe(422);
    expect(bad.body.error).toMatchObject({ code: 'MALWARE' });
    expect(bad.body.error.message).toContain('Win.Test.EICAR_HDB-1');
    expect(await prisma.attachment.count({ where: { draftId: d.id } })).toBe(0);
    expect(s3.objects.size).toBe(objects);
    const ok = await admin.upload(`/drafts/${d.id}/attachments`, 'notes.txt', Buffer.from('meeting notes'));
    expect(ok.status).toBe(201);
    expect((await prisma.attachment.findFirstOrThrow({ where: { draftId: d.id } })).scanStatus).toBe('CLEAN');
  });

  it('a received infected file is blocked on download, every time, and audited', async () => {
    const att = await attOf('t-bad1');
    const r = await admin.get(`/attachments/${att.id}/download`);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('MALWARE');
    expect((await prisma.attachment.findUniqueOrThrow({ where: { id: att.id } })).scanStatus).toBe('INFECTED');
    expect(await prisma.auditLog.count({ where: { action: 'attachment.blocked', entityId: att.id } })).toBe(1);
    const scans = clamd.scans;
    expect((await admin.get(`/attachments/${att.id}/download`)).status).toBe(422);
    expect(clamd.scans).toBe(scans); // known bad: refused without fetching or scanning again
  });

  it('forwarding an infected file fails the send instead of passing it on', async () => {
    const t = await thread('t-bad1');
    const d = (await admin.post('/drafts', { mode: 'FORWARD', threadId: t.id })).body;
    await admin.patch(`/drafts/${d.id}`, { to: [{ address: 'partner@agency.com' }] });
    const sentBefore = fake.gmailSent.length;
    expect((await admin.post(`/drafts/${d.id}/send`, {})).status).toBe(202);
    expect(await runSends(d.id)).toEqual(['failed']);
    expect(fake.gmailSent.length).toBe(sentBefore);
    expect((await prisma.draft.findUniqueOrThrow({ where: { id: d.id } })).sendError).toMatch(/malware/);
  });

  it('when the scanner is down, files are refused (503), never let through unscanned', async () => {
    clamd.down = true;
    try {
      const d = (await admin.post('/drafts', { mode: 'NEW', emailAccountId: boxId })).body;
      const up = await admin.upload(`/drafts/${d.id}/attachments`, 'a.txt', Buffer.from('text'));
      expect(up.status).toBe(503);
      expect(up.body.error.code).toBe('SCANNER_UNAVAILABLE');
      fake.gmailAdd(box, gmailMessage(box, 'ok2', { subject: 'Another', attachment: { filename: 'b.pdf', mime: 'application/pdf', size: 40 } }));
      await sync.run(boxId, 'WEBHOOK');
      const att = await attOf('t-ok2');
      expect((await admin.get(`/attachments/${att.id}/download`)).status).toBe(503);
      expect((await prisma.attachment.findUniqueOrThrow({ where: { id: att.id } })).scanStatus).toBe('PENDING');
    } finally {
      clamd.down = false;
    }
  });
});

describe('Phase 10: encrypted object storage', () => {
  it('the S3 client signs with SigV4 (the stand-in verifies every signature)', async () => {
    const c = new S3Client(s3.cfg);
    await c.put('probe/a b+c.txt', Buffer.from('x'));
    expect((await c.get('probe/a b+c.txt'))?.toString()).toBe('x');
    await c.delete('probe/a b+c.txt');
    expect(await c.get('probe/a b+c.txt')).toBeNull();
    const wrong = new S3Client({ ...s3.cfg, secretAccessKey: 'wrong' });
    await expect(wrong.put('probe/x', Buffer.from('x'))).rejects.toThrow(/403/);
    expect(s3.rejected).toBeGreaterThan(0);
  });

  it('a received file is kept encrypted after its first download and served from storage', async () => {
    const att = await attOf('t-ok1');
    const first = await admin.get(`/attachments/${att.id}/download`);
    expect(first.status).toBe(200);
    expect(Buffer.from(first.body).toString()).toBe(attachmentBytes('ok1'));
    const row = await prisma.attachment.findUniqueOrThrow({ where: { id: att.id } });
    expect(row).toMatchObject({ scanStatus: 'CLEAN', storageKey: `attachments/${att.id}` });
    const blob = s3.objects.get(row.storageKey!)!;
    expect(blob).toBeTruthy();
    expect(blob.includes(Buffer.from(attachmentBytes('ok1')))).toBe(false); // ciphertext only
    const scans = clamd.scans;
    // Served from storage: works even while the mailbox is paused (Gmail is not asked again).
    await prisma.emailAccount.update({ where: { id: boxId }, data: { status: 'PAUSED' } });
    const second = await admin.get(`/attachments/${att.id}/download`);
    await prisma.emailAccount.update({ where: { id: boxId }, data: { status: 'ACTIVE' } });
    expect(second.status).toBe(200);
    expect(Buffer.from(second.body).toString()).toBe(attachmentBytes('ok1'));
    expect(clamd.scans).toBe(scans); // already clean
  });

  it('uploads live in storage (not the database) until sent, then are deleted', async () => {
    const d = (await admin.post('/drafts', { mode: 'NEW', emailAccountId: boxId })).body;
    await admin.patch(`/drafts/${d.id}`, { to: [{ address: 'client@acme.com' }], subject: 'Proposal', bodyHtml: '<p>Attached</p>' });
    expect((await admin.upload(`/drafts/${d.id}/attachments`, 'proposal.txt', Buffer.from('the proposal text'))).status).toBe(201);
    const a = await prisma.attachment.findFirstOrThrow({ where: { draftId: d.id } });
    expect(a.content).toBeNull();
    expect(s3.objects.has(a.storageKey!)).toBe(true);
    expect((await admin.post(`/drafts/${d.id}/send`, {})).status).toBe(202);
    expect(await runSends(d.id)).toEqual(['sent']);
    expect(fake.gmailSent.at(-1)!.raw).toContain(Buffer.from('the proposal text').toString('base64'));
    expect(s3.objects.has(a.storageKey!)).toBe(false);
    expect((await prisma.attachment.findUniqueOrThrow({ where: { id: a.id } })).storageKey).toBeNull();
  });

  it('deleting a draft or one of its files deletes the stored copy', async () => {
    const d = (await admin.post('/drafts', { mode: 'NEW', emailAccountId: boxId })).body;
    await admin.upload(`/drafts/${d.id}/attachments`, 'one.txt', Buffer.from('one'));
    const two = (await admin.upload(`/drafts/${d.id}/attachments`, 'two.txt', Buffer.from('two'))).body.attachments.find((x: { filename: string }) => x.filename === 'two.txt');
    expect(two.storageKey).toBeUndefined(); // internal keys are not exposed
    const rows = await prisma.attachment.findMany({ where: { draftId: d.id } });
    await admin.del(`/drafts/${d.id}/attachments/${two.id}`);
    expect(s3.objects.has(rows.find((r) => r.id === two.id)!.storageKey!)).toBe(false);
    await admin.del(`/drafts/${d.id}`);
    for (const r of rows) expect(s3.objects.has(r.storageKey!)).toBe(false);
  });

  it('the retention purge deletes stored files with the mail', async () => {
    const att = await attOf('t-ok1');
    const key = (await prisma.attachment.findUniqueOrThrow({ where: { id: att.id } })).storageKey!;
    expect(s3.objects.has(key)).toBe(true);
    await prisma.emailAccount.update({ where: { id: boxId }, data: { status: 'DISCONNECTED', purgeAfter: new Date(Date.now() - 1000) } });
    // The worker runs the purge; build it from the app's providers the same way.
    await new RetentionService(app.get(PrismaService), app.get(AuditService), app.get(FileStore)).purgeDue();
    expect(s3.objects.has(key)).toBe(false);
  });
});
