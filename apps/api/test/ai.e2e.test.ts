import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@crm/crypto';
import { AUTOMATION_ACTIONS, automationActionSchema } from '@crm/shared';
import { MailWorkerService } from '../src/mail/mail-worker.service';
import { QUEUES, QueueService, type AiJob, type AutomationJob } from '../src/mail/queue.service';
import { SyncService } from '../src/mail/sync.service';
import { WorkerModule } from '../src/worker.module';
import { FakeMail } from './fake-mail';
import { FakeOpenAi } from './fake-openai';
import { bootApp, type Client, clientAs, makeDepartment, makeUser, prisma } from './helpers';
import { connectMailbox, gmailMessage, MAIL_ENV, uniqueMailbox } from './mail-helpers';

let fake: FakeMail;
let openai: FakeOpenAi;
let app: INestApplication;
let worker: INestApplicationContext;
let sync: SyncService;
let admin: Client;
const sales = uniqueMailbox('aisales');
const hr = uniqueMailbox('aihr');
const ids: Record<string, string> = {};
const people: Record<string, { id: string }> = {};
const as: Record<string, Client> = {};
let salesDept: { id: string };
let otherDept: { id: string };
let team: { id: string };
let seq = 0;
const stamp = Date.now().toString(36);

async function receive(box: string, over: Parameters<typeof gmailMessage>[2] = {}) {
  const id = `ai${++seq}${stamp}`;
  fake.gmailAdd(box, gmailMessage(box, id, { date: new Date(), ...over }));
  await sync.run(ids[box]!, 'WEBHOOK');
  return prisma.emailThread.findFirstOrThrow({ where: { providerThreadId: over.threadId ?? `t-${id}` } });
}

/** Runs queued AI and automation jobs the way the worker does. */
async function drain() {
  const boss = await app.get(QueueService).get();
  const w = worker.get(MailWorkerService);
  let n = 0;
  for (let round = 0; round < 3; round++) {
    const aiJobs = await boss.findJobs<AiJob>(QUEUES.ai, { queued: true });
    for (const j of aiJobs) {
      await w.handleAi(j.data);
      await boss.deleteJob(QUEUES.ai, j.id);
      n++;
    }
    const autoJobs = await boss.findJobs<AutomationJob>(QUEUES.automation, { queued: true });
    for (const j of autoJobs) {
      await w.handleAutomation(j.data);
      await boss.deleteJob(QUEUES.automation, j.id);
      n++;
    }
  }
  return n;
}
/** Queued sends for drafts of this file's mailboxes (other test files share the queue). */
const sendJobs = async () => {
  const mine = new Set((await prisma.draft.findMany({ where: { emailAccountId: { in: Object.values(ids) } }, select: { id: true } })).map((d) => d.id));
  return (await (await app.get(QueueService).get()).findJobs<{ draftId: string }>(QUEUES.send, { queued: true })).filter((j) => mine.has(j.data.draftId)).length;
};

beforeAll(async () => {
  fake = await new FakeMail().start();
  openai = await new FakeOpenAi().start();
  const env = { ...MAIL_ENV, OPENAI_API_KEY: 'sk-test-key', OPENAI_BASE_URL: openai.baseUrl, OPENAI_MODEL: 'gpt-test', AI_AUTO_ANALYZE: 'true' };
  const booted = await bootApp({ mailEndpoints: fake.endpoints(), env });
  app = booted.app;
  worker = await NestFactory.createApplicationContext(WorkerModule.register(booted.cfg, { mailEndpoints: fake.endpoints() }), { logger: false });
  sync = app.get(SyncService);
  admin = await clientAs(app, (await makeUser({ role: 'SUPER_ADMIN', name: 'Admin' })).id);
  salesDept = await makeDepartment();
  otherDept = await makeDepartment();
  for (const [k, role, dept] of [
    ['rep1', 'SALES', salesDept],
    ['rep2', 'SALES', salesDept],
    ['mgr', 'DEPT_MANAGER', salesDept],
    ['emp', 'EMPLOYEE', otherDept],
  ] as const) {
    people[k] = await makeUser({ role, departmentId: dept.id, name: `AI ${k}` });
    as[k] = await clientAs(app, people[k]!.id);
  }
  await prisma.department.update({ where: { id: salesDept.id }, data: { managerId: people.mgr!.id } });
  team = await prisma.team.create({ data: { id: newId(), name: `AI team ${stamp}`, departmentId: salesDept.id } });
  for (const k of ['rep1', 'rep2']) await prisma.teamMember.create({ data: { teamId: team.id, userId: people[k]!.id, inRotation: true } });
  for (const box of [sales, hr]) {
    ids[box] = await connectMailbox(admin, fake, 'google', box);
    await sync.run(ids[box]!, 'INITIAL');
  }
  await prisma.emailAccount.update({ where: { id: ids[sales]! }, data: { departmentId: salesDept.id } });
  // HR mail must never reach the AI provider.
  expect((await admin.patch(`/accounts/${ids[hr]}`, { aiEnabled: false })).status).toBe(200);
  // Both reps may reply from sales@ (needed for drafts).
  await admin.put(`/accounts/${ids[sales]}/access`, { grants: [{ departmentId: salesDept.id, level: 'REPLY' }] });
});

afterAll(async () => {
  await worker?.close();
  await app?.close();
  fake?.stop();
  openai?.stop();
});

describe('AI insights', () => {
  let threadId: string;

  it('new mail is analysed automatically; the result is cached and access-checked', async () => {
    expect((await admin.get('/ai/status')).body).toEqual({ enabled: true, model: 'gpt-test', autoAnalyze: true });
    const t = await receive(sales, { from: 'Meera <meera@prospect.example>', subject: 'Quote for SEO services', text: 'Hi, can you send a quote for SEO services for our shop?' });
    threadId = t.id;
    const before = openai.requests.length;
    await drain();
    expect(openai.requests.length).toBe(before + 1);
    const req = openai.requests.at(-1)!;
    expect(req.authorization).toBe('Bearer sk-test-key');
    expect(req.schema).toBe('thread_insights');
    expect(req.user).toContain('can you send a quote for SEO services');
    expect(req.system).toContain('untrusted data');

    const r = await admin.get(`/threads/${threadId}/insights`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ available: true, stale: false, category: 'SALES_ENQUIRY', sentiment: 'POSITIVE', urgency: { level: 'NORMAL' }, lead: { isLead: true, serviceInterest: 'SEO' }, followUp: { needed: true, inDays: 2 } });
    expect(r.body.summary).toContain('quote');
    // Reading the cache does not call the AI again.
    await admin.get(`/threads/${threadId}/insights`);
    expect(openai.requests.length).toBe(before + 1);
    // Employees outside the conversation see nothing; ai.use follows conversation access.
    expect((await as.emp!.get(`/threads/${threadId}/insights`)).status).toBe(404);
  });

  it('internal notes are never sent to the AI', async () => {
    const secret = `internal-secret-${stamp}`;
    expect((await admin.post(`/threads/${threadId}/notes`, { body: `Do not tell the client: ${secret}` })).status).toBe(201);
    const r = await admin.post(`/threads/${threadId}/insights/refresh`);
    expect(r.status).toBe(200);
    expect(openai.requests.some((q) => q.user.includes(secret) || q.system.includes(secret))).toBe(false);
  });

  it('a newer message makes the insights stale', async () => {
    const t = await prisma.emailThread.findUniqueOrThrow({ where: { id: threadId } });
    await receive(sales, { threadId: t.providerThreadId!, from: 'meera@prospect.example', subject: 'Re: Quote for SEO services', text: 'Also, this is urgent.' });
    // Not drained yet: the cache is from before the new message.
    expect((await admin.get(`/threads/${threadId}/insights`)).body.stale).toBe(true);
    await drain();
    expect((await admin.get(`/threads/${threadId}/insights`)).body).toMatchObject({ stale: false, urgency: { level: 'URGENT' } });
  });

  it('a mailbox with AI switched off is never sent to the AI', async () => {
    const before = openai.requests.length;
    const t = await receive(hr, { from: 'Candidate <cv@person.example>', subject: 'Application and quote', text: `My salary expectation is private-${stamp}` });
    await drain();
    expect(openai.requests.length).toBe(before);
    expect(openai.requests.some((q) => q.user.includes(`private-${stamp}`))).toBe(false);
    expect((await admin.get(`/threads/${t.id}/insights`)).body).toMatchObject({ available: false, reason: 'AI is switched off for this mailbox' });
    const refresh = await admin.post(`/threads/${t.id}/insights/refresh`);
    expect(refresh.status).toBe(403);
    expect(refresh.body.error.code).toBe('AI_NOT_ALLOWED');
    expect((await admin.post('/ai/suggest-reply', { threadId: t.id })).status).toBe(403);
    expect(openai.requests.length).toBe(before);
  });

  it('an AI outage is reported, not hidden', async () => {
    openai.failNext = { status: 500, count: 1 };
    const r = await admin.post(`/threads/${threadId}/insights/refresh`);
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('AI_UNAVAILABLE');
  });
});

describe('AI replies stay drafts', () => {
  it('a suggestion becomes a draft only on request, and the draft is not sent', async () => {
    const t = await receive(sales, { from: 'Ravi <ravi@client2.example>', subject: 'Pricing question', text: 'What does PPC management cost?' });
    await admin.post(`/threads/${t.id}/assign`, { assigneeId: people.rep1!.id });
    await drain();
    const s = await as.rep1!.post('/ai/suggest-reply', { threadId: t.id, tone: 'friendly', instructions: 'Offer a call next week' });
    expect(s.status).toBe(201);
    expect(s.body).toMatchObject({ status: 'PROPOSED', kind: 'REPLY', tone: 'friendly' });
    expect(openai.requests.at(-1)!.user).toContain('Offer a call next week');
    expect((await as.rep1!.get(`/threads/${t.id}/ai-suggestions`)).body.map((x: { id: string }) => x.id)).toContain(s.body.id);

    // Another employee cannot use someone else's suggestion.
    expect((await as.rep2!.post(`/ai/suggestions/${s.body.id}/use`)).status).toBe(404);
    const d = await as.rep1!.post(`/ai/suggestions/${s.body.id}/use`);
    expect(d.status).toBe(201);
    expect(d.body).toMatchObject({ source: 'AI', status: 'EDITING', threadId: t.id });
    expect(d.body.bodyHtml).toContain('<p>Dear client,</p>');
    expect(d.body.to.map((x: { address: string }) => x.address)).toEqual(['ravi@client2.example']);
    expect(await sendJobs()).toBe(0);
    expect((await prisma.aiSuggestion.findUniqueOrThrow({ where: { id: s.body.id } })).status).toBe('USED_AS_DRAFT');
    expect((await as.rep1!.post(`/ai/suggestions/${s.body.id}/use`)).status).toBe(409);
    expect(await prisma.auditLog.count({ where: { action: 'ai.suggestion.use', entityId: s.body.id } })).toBe(1);

    // Rewriting returns text; the draft itself is unchanged until the employee saves it.
    const rw = await as.rep1!.post('/ai/rewrite', { draftId: d.body.id, text: 'i think teh price is fine', kind: 'grammar' });
    expect(rw.status).toBe(200);
    expect(rw.body.text).toBe('I think the price is fine');
    expect((await prisma.draft.findUniqueOrThrow({ where: { id: d.body.id } })).bodyHtml).toBe(d.body.bodyHtml);
    expect((await as.rep2!.post('/ai/rewrite', { draftId: d.body.id, text: 'x', kind: 'tone' })).status).toBe(404);
  });
});

describe('automation', () => {
  let tagId: string;
  let ruleId: string;

  beforeAll(async () => {
    tagId = (await admin.post('/tags', { name: `Hot lead ${stamp}`, color: '#cc0000' })).body.id;
  });

  it('admins only; department managers only for their own department', async () => {
    const body = { name: 'Mgr rule', trigger: 'MESSAGE_RECEIVED', conditions: { match: 'all', conditions: [] }, actions: [{ type: 'set_priority', priority: 'HIGH' }] };
    expect((await as.emp!.get('/automation-rules')).status).toBe(403);
    expect((await as.mgr!.post('/automation-rules', body)).status).toBe(422);
    expect((await as.mgr!.post('/automation-rules', { ...body, departmentId: otherDept.id })).status).toBe(422);
    const ok = await as.mgr!.post('/automation-rules', { ...body, departmentId: salesDept.id });
    expect(ok.status).toBe(201);
    // A manager cannot assign outside the department.
    expect((await as.mgr!.post('/automation-rules', { ...body, departmentId: salesDept.id, actions: [{ type: 'assign', targetType: 'USER', targetUserId: people.emp!.id }] })).status).toBe(422);
    await as.mgr!.del(`/automation-rules/${ok.body.id}`);
    // Sending is not an action that exists.
    expect((await admin.post('/automation-rules', { ...body, actions: [{ type: 'send_email', to: 'x@y.z' }] })).status).toBe(422);
  });

  it('a rule on new mail: assign, prioritise, tag, task, AI draft for the assignee, notify; once per event; nothing sent', async () => {
    const r = await admin.post('/automation-rules', {
      name: 'Sales enquiries',
      trigger: 'MESSAGE_RECEIVED',
      isEnabled: true,
      conditions: { match: 'all', conditions: [{ field: 'mailbox', op: 'is', value: ids[sales] }, { field: 'category', op: 'is', value: 'SALES_ENQUIRY' }] },
      actions: [
        { type: 'assign', targetType: 'TEAM', teamId: team.id, strategy: 'ROUND_ROBIN' },
        { type: 'set_priority', priority: 'HIGH' },
        { type: 'add_tag', tagId },
        { type: 'create_task', title: 'Call the prospect', dueInHours: 4 },
        { type: 'request_ai_draft', tone: 'professional', instructions: 'Propose a call' },
        { type: 'notify', to: 'department_manager', message: 'New sales enquiry' },
      ],
    });
    expect(r.status).toBe(201);
    ruleId = r.body.id;
    const t = await receive(sales, { from: 'Lena <lena@shop.example>', subject: 'Website redesign quote', text: 'We need a quote for a website redesign.' });
    await drain();
    const after = await prisma.emailThread.findUniqueOrThrow({ where: { id: t.id }, include: { tags: true } });
    expect([people.rep1!.id, people.rep2!.id]).toContain(after.assigneeId);
    expect(after.priority).toBe('HIGH');
    expect(after.tags.map((x) => x.tagId)).toContain(tagId);
    expect(await prisma.task.count({ where: { threadId: t.id, title: 'Call the prospect', assigneeId: after.assigneeId! } })).toBe(1);
    const draft = await prisma.draft.findFirstOrThrow({ where: { threadId: t.id } });
    expect(draft).toMatchObject({ authorId: after.assigneeId, source: 'AI', status: 'EDITING', approvedAt: null });
    expect(await prisma.notification.count({ where: { userId: after.assigneeId!, type: 'AUTOMATION', threadId: t.id } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: people.mgr!.id, type: 'AUTOMATION', title: 'New sales enquiry' } })).toBe(1);
    expect(await sendJobs()).toBe(0);
    const runs = (await admin.get(`/automation-rules/${ruleId}/runs`)).body;
    expect(runs[0]).toMatchObject({ status: 'SUCCEEDED', thread: { id: t.id } });
    expect(runs[0].output.map((o: { type: string }) => o.type)).toEqual(['assign', 'set_priority', 'add_tag', 'create_task', 'request_ai_draft', 'notify']);
    expect(await prisma.auditLog.count({ where: { action: 'thread.automation', entityId: t.id } })).toBe(1);

    // The same event again does nothing.
    const latest = await prisma.emailMessage.findFirstOrThrow({ where: { threadId: t.id, direction: 'INBOUND' }, orderBy: { receivedAt: 'desc' } });
    await worker.get(MailWorkerService).handleAutomation({ trigger: 'MESSAGE_RECEIVED', eventKey: `msg:${latest.id}`, threadId: t.id });
    expect(await prisma.automationRun.count({ where: { ruleId, threadId: t.id } })).toBe(1);
    // Mail that does not match runs nothing.
    const other = await receive(sales, { from: 'news@letter.example', subject: 'Weekly news', text: 'Our newsletter' });
    await drain();
    expect(await prisma.automationRun.count({ where: { ruleId, threadId: other.id } })).toBe(0);
  });

  it('dry run shows what would happen and writes nothing', async () => {
    const t = await receive(sales, { from: 'Omar <omar@biz.example>', subject: 'Need pricing for SEO services', text: 'Please send pricing' });
    await prisma.automationRule.update({ where: { id: ruleId }, data: { isEnabled: false } });
    await drain();
    const runsBefore = await prisma.automationRun.count();
    const r = await admin.post(`/automation-rules/${ruleId}/test`, { threadId: t.id });
    expect(r.status).toBe(200);
    expect(r.body.matched).toBe(true);
    expect(r.body.facts.category).toBe('SALES_ENQUIRY');
    expect(r.body.actions.find((a: { type: string }) => a.type === 'request_ai_draft').detail).toContain('never sent automatically');
    expect(await prisma.automationRun.count()).toBe(runsBefore);
    expect((await prisma.emailThread.findUniqueOrThrow({ where: { id: t.id } })).assigneeId).toBeNull();
    expect((await admin.post(`/automation-rules/${ruleId}/enable`)).body.isEnabled).toBe(true);
    expect((await admin.post(`/automation-rules/${ruleId}/disable`)).body.isEnabled).toBe(false);
  });

  it('a detected lead fires LEAD_DETECTED (create a lead)', async () => {
    const r = await admin.post('/automation-rules', { name: 'Leads from AI', trigger: 'LEAD_DETECTED', isEnabled: true, departmentId: salesDept.id, conditions: { match: 'all', conditions: [] }, actions: [{ type: 'create_lead', serviceInterest: 'SEO' }] });
    expect(r.status).toBe(201);
    const t = await receive(sales, { from: 'Priya <priya@newco.example>', subject: 'Quote please', text: 'Can we get a proposal for SEO services?' });
    await drain();
    expect(await prisma.lead.count({ where: { sourceThreadId: t.id, serviceInterest: 'SEO' } })).toBe(1);
    // A rule limited to another department does not run here.
    const o = await admin.post('/automation-rules', { name: 'Other dept', trigger: 'LEAD_DETECTED', isEnabled: true, departmentId: otherDept.id, conditions: { match: 'all', conditions: [] }, actions: [{ type: 'set_priority', priority: 'LOW' }] });
    const t2 = await receive(sales, { from: 'Sam <sam@co3.example>', subject: 'Quote for SEO services', text: 'quote please' });
    await drain();
    expect(await prisma.automationRun.count({ where: { ruleId: o.body.id } })).toBe(0);
    expect((await prisma.emailThread.findUniqueOrThrow({ where: { id: t2.id } })).priority).not.toBe('LOW');
  });

  it('absence reassignment: marking someone absent hands their open conversations to the team', async () => {
    await admin.post('/automation-rules', { name: 'Cover for absent reps', trigger: 'USER_ABSENT', isEnabled: true, departmentId: salesDept.id, conditions: { match: 'all', conditions: [] }, actions: [{ type: 'reassign_absent', to: 'pool' }, { type: 'notify', to: 'department_manager', message: 'Conversations were reassigned for an absence' }] });
    const a = await receive(sales, { from: 'x1@abs.example', subject: 'Open one' });
    const b = await receive(sales, { from: 'x2@abs.example', subject: 'Open two' });
    for (const t of [a, b]) {
      await prisma.emailThread.update({ where: { id: t.id }, data: { teamId: team.id } });
      await admin.post(`/threads/${t.id}/assign`, { assigneeId: people.rep1!.id });
    }
    await drain();
    expect((await admin.put(`/users/${people.rep1!.id}/absence`, { isAbsent: true })).status).toBe(200);
    await drain();
    for (const t of [a, b]) expect((await prisma.emailThread.findUniqueOrThrow({ where: { id: t.id } })).assigneeId).toBe(people.rep2!.id);
    expect(await prisma.assignment.count({ where: { threadId: a.id, method: 'ABSENCE_REASSIGN' } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: people.mgr!.id, title: 'Conversations were reassigned for an absence' } })).toBe(1);
    await admin.put(`/users/${people.rep1!.id}/absence`, { isAbsent: false });
  });
});

describe('no code path sends AI or automation output without a human', () => {
  const src = path.resolve(__dirname, '../src');
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(path.join(dir, f)).isDirectory() ? files(path.join(dir, f)) : f.endsWith('.ts') ? [path.join(dir, f)] : []));
  const all = files(src).map((f) => ({ f: path.relative(src, f).replace(/\\/g, '/'), text: readFileSync(f, 'utf8') }));

  it('only the human “Send” on a draft queues mail, and only the send worker talks to SMTP / Gmail send / Graph send', () => {
    const queueing = all.filter((x) => /\.enqueueSend\(/.test(x.text)).map((x) => x.f);
    expect(queueing).toEqual(['compose/drafts.service.ts']);
    const sending = all.filter((x) => /smtpSend\(|\.sendDraft\(|gmail\.send\(/.test(x.text)).map((x) => x.f);
    expect(sending).toEqual(['compose/send.service.ts']);
    // AI and automation code cannot reach the send path at all.
    for (const x of all.filter((y) => y.f.startsWith('ai/') || y.f.startsWith('automation/'))) {
      expect(x.text).not.toMatch(/send\.service|enqueueSend|smtpSend|sendDraft|\.send\(ctx/);
    }
  });

  it('the automation action list has no sending action, and unknown actions are refused', () => {
    expect(AUTOMATION_ACTIONS.some((a) => /send|mail|reply|forward/i.test(a))).toBe(false);
    expect(automationActionSchema.safeParse({ type: 'send_email' }).success).toBe(false);
  });

  it('nothing AI or automation produced in this run was queued or sent', async () => {
    const aiDrafts = await prisma.draft.findMany({ where: { source: 'AI', emailAccountId: { in: Object.values(ids) } } });
    expect(aiDrafts.length).toBeGreaterThan(0);
    for (const d of aiDrafts) {
      expect(d.status).toBe('EDITING');
      expect(d.approvedAt).toBeNull();
      expect(d.sentMessageId).toBeNull();
    }
    expect(await sendJobs()).toBe(0);
  });

  it('the send worker refuses a draft nobody approved', async () => {
    const d = await prisma.draft.findFirstOrThrow({ where: { source: 'AI' } });
    const { sender } = await (await import('./mail-helpers')).workerServices(app);
    expect(await sender.send({ draftId: d.id, approvedAt: new Date().toISOString() } as never)).toBe('skipped');
    expect((await prisma.draft.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('EDITING');
  });
});
