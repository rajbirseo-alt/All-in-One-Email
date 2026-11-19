import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@crm/crypto';
import { SyncService } from '../src/mail/sync.service';
import { TasksService } from '../src/crm/tasks.service';
import { FakeMail } from './fake-mail';
import { bootApp, type Client, clientAs, DOMAIN, makeDepartment, makeUser, prisma } from './helpers';
import { connectMailbox, daysAgo, gmailMessage, MAIL_ENV, uniqueMailbox } from './mail-helpers';

let fake: FakeMail;
let app: INestApplication;
let sync: SyncService;
let admin: Client;
const stamp = Date.now().toString(36);
/** A client company domain unique to this run (the test database is shared by all files). */
const acme = `acme-${stamp}.com`;
const sales = uniqueMailbox('sales');
const support = uniqueMailbox('support');
const ids: Record<string, string> = {};
let salesDept: { id: string };
let otherDept: { id: string };
const people: Record<string, { id: string; name: string }> = {};
const as: Record<string, Client> = {};
let seq = 0;

const thread = (providerThreadId: string) => prisma.emailThread.findFirstOrThrow({ where: { providerThreadId } });
async function receive(box: string, over: Parameters<typeof gmailMessage>[2] = {}) {
  const id = `crm${++seq}`;
  fake.gmailAdd(box, gmailMessage(box, id, { date: new Date(), ...over }));
  await sync.run(ids[box]!, 'WEBHOOK');
  return thread(over.threadId ?? `t-${id}`);
}
const contactOf = async (threadId: string) => {
  const t = await prisma.emailThread.findUniqueOrThrow({ where: { id: threadId } });
  return t.contactId ? prisma.contact.findUniqueOrThrow({ where: { id: t.contactId }, include: { emails: true, company: true } }) : null;
};

beforeAll(async () => {
  fake = await new FakeMail().start();
  ({ app } = await bootApp({ mailEndpoints: fake.endpoints(), env: MAIL_ENV }));
  sync = app.get(SyncService);
  admin = await clientAs(app, (await makeUser({ role: 'SUPER_ADMIN', name: 'Admin' })).id);
  salesDept = await makeDepartment();
  otherDept = await makeDepartment();
  for (const [k, role, dept] of [
    ['rep1', 'SALES', salesDept],
    ['rep2', 'SALES', salesDept],
    ['mgr', 'DEPT_MANAGER', salesDept],
    ['emp', 'EMPLOYEE', otherDept],
    ['emp2', 'EMPLOYEE', otherDept],
  ] as const) {
    people[k] = await makeUser({ role, departmentId: dept.id, name: `Person ${k}` });
    as[k] = await clientAs(app, people[k]!.id);
  }
  await prisma.department.update({ where: { id: salesDept.id }, data: { managerId: people.mgr!.id } });
  for (const box of [sales, support]) {
    ids[box] = await connectMailbox(admin, fake, 'google', box);
    await sync.run(ids[box]!, 'INITIAL');
  }
  await prisma.emailAccount.update({ where: { id: ids[sales]! }, data: { departmentId: salesDept.id } });
});

afterAll(async () => {
  await app?.close();
  fake?.stop();
});

describe('automatic contacts', () => {
  it('creates the contact and the company (by domain) from the first email, and reuses them', async () => {
    const t1 = await receive(support, { from: `"Jane Doe" <jane@${acme}>`, subject: 'Question about SEO' });
    const c = (await contactOf(t1.id))!;
    expect(c.name).toBe('Jane Doe');
    expect(c.emails.map((e) => e.email)).toEqual([`jane@${acme}`]);
    expect(c.company?.domain).toBe(acme);
    expect(c.company?.name).toBe(`Acme ${stamp}`.replace(/\b\w/g, (x) => x.toUpperCase()));
    expect(c.lastContactedAt?.getTime()).toBe(t1.lastMessageAt.getTime());

    const t2 = await receive(support, { from: `Jane <JANE@${acme}>`, subject: 'Another question' });
    expect((await contactOf(t2.id))!.id).toBe(c.id);
    // A colleague at the same company joins the same company.
    const t3 = await receive(support, { from: `Bob <bob@${acme}>` });
    const bob = (await contactOf(t3.id))!;
    expect(bob.id).not.toBe(c.id);
    expect(bob.companyId).toBe(c.companyId);
  });

  it('never makes a company for free mail, and never makes contacts of robots or colleagues', async () => {
    const t = await receive(support, { from: `Raj <raj.${stamp}@gmail.com>` });
    const c = (await contactOf(t.id))!;
    expect(c.companyId).toBeNull();
    expect(await prisma.company.count({ where: { domain: 'gmail.com' } })).toBe(0);

    const robot = await receive(support, { from: `no-reply@billing-${stamp}.com` });
    expect(robot.contactId).toBeNull();
    const colleague = await receive(support, { from: `Colleague <someone.${stamp}@${DOMAIN}>` });
    expect((await prisma.emailThread.findUniqueOrThrow({ where: { id: colleague.id } })).contactId).toBeNull();
  });

  it('uses the Reply-To of a website enquiry form', async () => {
    const t = await receive(sales, { from: `Website <wordpress@${DOMAIN}>`, replyTo: `"Priya Shah" <priya@shah-${stamp}.in>`, subject: 'New enquiry from the website' });
    const c = (await contactOf(t.id))!;
    expect(c.emails[0]!.email).toBe(`priya@shah-${stamp}.in`);
    expect(c.name).toBe('Priya Shah');
    expect(c.departmentId).toBe(salesDept.id);
  });
});

describe('contact access', () => {
  it('an employee sees the contact of a conversation assigned to them, and nobody else’s', async () => {
    const mine = await receive(support, { from: `Mine <mine@client-${stamp}.com>` });
    const theirs = await receive(support, { from: `Theirs <theirs@client-${stamp}.com>` });
    expect((await admin.post(`/threads/${mine.id}/assign`, { assigneeId: people.emp!.id })).status).toBe(204);
    const myContact = (await contactOf(mine.id))!;
    const theirContact = (await contactOf(theirs.id))!;

    expect((await as.emp!.get(`/contacts/${myContact.id}`)).status).toBe(200);
    expect((await as.emp!.get(`/contacts/${theirContact.id}`)).status).toBe(404);
    expect((await as.emp2!.get(`/contacts/${myContact.id}`)).status).toBe(404);
    const list = await as.emp!.get('/contacts?limit=100');
    expect(list.body.items.map((c: { id: string }) => c.id)).toContain(myContact.id);
    expect(list.body.items.map((c: { id: string }) => c.id)).not.toContain(theirContact.id);
    // The conversation panel shows the contact; the timeline shows only readable conversations.
    const panel = await as.emp!.get(`/threads/${mine.id}/crm`);
    expect(panel.status).toBe(200);
    expect(panel.body.contact.id).toBe(myContact.id);
    expect(panel.body.canCreateLead).toBe(false); // employees have no lead permission
    const tl = await as.emp!.get(`/contacts/${myContact.id}/timeline`);
    expect(tl.body.threads.map((t: { id: string }) => t.id)).toEqual([mine.id]);
    // Employees cannot see leads or merge.
    expect((await as.emp!.get('/leads')).status).toBe(403);
    expect((await as.emp!.get('/contacts/duplicates')).status).toBe(403);
  });

  it('a department sees the contacts filed under it', async () => {
    const t = await receive(sales, { from: `Dept <dept@dept-${stamp}.com>` });
    const c = (await contactOf(t.id))!;
    expect(c.departmentId).toBe(salesDept.id);
    expect((await as.rep1!.get(`/contacts/${c.id}`)).status).toBe(200);
    expect((await as.emp!.get(`/contacts/${c.id}`)).status).toBe(404);
  });
});

describe('editing contacts and companies', () => {
  let id: string;
  it('creates a contact with several addresses, refusing an address another contact has', async () => {
    const r = await as.rep1!.post('/contacts', { name: 'Manual Person', emails: [`manual@m-${stamp}.com`, `manual.alt@m-${stamp}.com`], phone: '+91 98765 43210', type: 'PROSPECT' });
    expect(r.status).toBe(201);
    id = r.body.id;
    expect(r.body.emails).toHaveLength(2);
    expect(r.body.primaryEmail).toBe(`manual@m-${stamp}.com`);
    expect(r.body.owner.id).toBe(people.rep1!.id);
    expect(r.body.canEdit).toBe(true);
    const dup = await as.rep1!.post('/contacts', { emails: [`jane@${acme}`] });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('EMAIL_IN_USE');
    // An OWN/DEPARTMENT user cannot hand a contact to someone outside their reach.
    expect((await as.rep1!.post('/contacts', { emails: [`x@x-${stamp}.com`], ownerId: people.emp!.id })).status).toBe(422);
    expect(await prisma.auditLog.count({ where: { action: 'contact.create', entityId: id } })).toBe(1);
  });

  it('adds, promotes and removes addresses; edits fields and tags', async () => {
    let r = await as.rep1!.post(`/contacts/${id}/emails`, { email: `third@m-${stamp}.com`, isPrimary: true });
    expect(r.status).toBe(201);
    expect(r.body.primaryEmail).toBe(`third@m-${stamp}.com`);
    const third = r.body.emails.find((e: { email: string }) => e.email === `third@m-${stamp}.com`);
    r = await as.rep1!.del(`/contacts/${id}/emails/${third.id}`);
    expect(r.status).toBe(200);
    expect(r.body.emails.filter((e: { isPrimary: boolean }) => e.isPrimary)).toHaveLength(1);
    for (const e of r.body.emails.slice(1)) await as.rep1!.del(`/contacts/${id}/emails/${e.id}`);
    const last = await as.rep1!.del(`/contacts/${id}/emails/${r.body.emails[0].id}`);
    expect(last.status).toBe(409);

    r = await as.rep1!.put(`/contacts/${id}`, { country: 'India', website: 'manual.example', notes: 'Met at a conference' });
    expect(r.status).toBe(200);
    expect(r.body.country).toBe('India');
    expect((await as.rep1!.put(`/contacts/${id}`, { website: 'not a site' })).status).toBe(422);
    const tag = await admin.post('/tags', { name: `VIP ${stamp}`, color: '#aa0000' });
    r = await as.rep1!.put(`/contacts/${id}/tags`, { tagIds: [tag.body.id] });
    expect(r.body.tags.map((t: { name: string }) => t.name)).toEqual([`VIP ${stamp}`]);
    // Someone outside the department cannot see it, let alone edit it.
    expect((await as.emp!.put(`/contacts/${id}`, { country: 'X' })).status).toBe(404);
  });

  it('companies: free mail and taken domains are refused', async () => {
    expect((await as.rep1!.post('/companies', { name: 'Gmail', domain: 'gmail.com' })).status).toBe(422);
    expect((await as.rep1!.post('/companies', { name: 'Again', domain: acme })).status).toBe(409);
    const r = await as.rep1!.post('/companies', { name: 'Globex', domain: `https://www.globex-${stamp}.com/about` });
    expect(r.status).toBe(201);
    expect(r.body.domain).toBe(`globex-${stamp}.com`);
    const list = await admin.get(`/companies?q=acme-${stamp}`);
    expect(list.body[0].contactCount).toBeGreaterThanOrEqual(2);
  });
});

describe('duplicates and merging', () => {
  let a: string;
  let b: string;
  let threadOfB: string;

  it('finds likely duplicates and lets an admin dismiss a pair', async () => {
    const t = await receive(support, { from: `"Ravi Kumar" <ravi.kumar@kumar-${stamp}.com>` });
    a = (await contactOf(t.id))!.id;
    const t2 = await receive(support, { from: `"Ravi Kumar" <ravi.kumar@gmail-alt-${stamp}.com>` });
    threadOfB = t2.id;
    b = (await contactOf(t2.id))!.id;
    await prisma.contact.update({ where: { id: a }, data: { phone: '+91 99999 11111' } });
    await prisma.contact.update({ where: { id: b }, data: { phone: '099999-11111', country: 'India' } });
    const d = await admin.get('/contacts/duplicates');
    expect(d.status).toBe(200);
    const pair = d.body.find((p: { a: { id: string }; b: { id: string } }) => [p.a.id, p.b.id].sort().join() === [a, b].sort().join());
    expect(pair).toBeTruthy();
    expect(pair.reasons).toEqual(expect.arrayContaining(['Same phone number', 'Same name', 'Same email name at another domain']));
    expect(pair.score).toBe(0.9);

    // A different pair, dismissed, disappears.
    const x = await prisma.contact.create({ data: { id: newId(), name: 'Dismiss Me', phone: '+44 20 7946 0000' } });
    const y = await prisma.contact.create({ data: { id: newId(), name: 'Other Person', phone: '020 7946 0000' } });
    const has = async () => (await admin.get('/contacts/duplicates')).body.some((p: { a: { id: string }; b: { id: string } }) => [p.a.id, p.b.id].includes(x.id) && [p.a.id, p.b.id].includes(y.id));
    expect(await has()).toBe(true);
    expect((await admin.post('/contacts/duplicates/dismiss', { aId: y.id, bId: x.id })).status).toBe(204);
    expect(await has()).toBe(false);
  });

  it('previews, merges, and an admin can undo the merge', async () => {
    const task = await admin.post('/tasks', { title: 'Call Ravi', contactId: b });
    expect(task.status).toBe(201);
    const preview = await admin.post(`/contacts/${a}/merge?dryRun=true`, { sourceContactIds: [b] });
    expect(preview.status).toBe(201);
    expect(preview.body.moves).toMatchObject({ emails: 1, threads: 1, tasks: 1 });
    expect(preview.body.fills).toEqual(expect.arrayContaining([{ field: 'Country', value: 'India' }]));
    expect(preview.body.conflicts).toEqual(expect.arrayContaining([{ field: 'Phone', kept: '+91 99999 11111', dropped: '099999-11111' }]));
    expect(preview.body.mergeIds).toBeUndefined();
    // Nothing changed yet.
    expect((await prisma.emailThread.findUniqueOrThrow({ where: { id: threadOfB } })).contactId).toBe(b);
    // Only holders of contact.merge.
    expect((await as.mgr!.post(`/contacts/${a}/merge`, { sourceContactIds: [b] })).status).toBe(403);

    const done = await admin.post(`/contacts/${a}/merge`, { sourceContactIds: [b] });
    expect(done.status).toBe(201);
    expect(done.body.mergeIds).toHaveLength(1);
    expect((await prisma.emailThread.findUniqueOrThrow({ where: { id: threadOfB } })).contactId).toBe(a);
    const merged = await admin.get(`/contacts/${a}`);
    expect(merged.body.emails).toHaveLength(2);
    expect(merged.body.country).toBe('India');
    expect(merged.body.merges).toHaveLength(1);
    // The merged contact is hidden and its id opens the survivor; new mail to its address lands on the survivor.
    expect((await admin.get(`/contacts/${b}`)).body.id).toBe(a);
    expect((await admin.get('/contacts?q=ravi.kumar&limit=100')).body.items.map((c: { id: string }) => c.id)).toEqual([a]);
    const again = await receive(support, { from: `ravi.kumar@gmail-alt-${stamp}.com` });
    expect((await contactOf(again.id))!.id).toBe(a);
    expect(await prisma.auditLog.count({ where: { action: 'contact.merge', entityId: a } })).toBe(1);

    const undo = await admin.post(`/contact-merges/${done.body.mergeIds[0]}/undo`);
    expect(undo.status).toBe(201);
    expect((await prisma.emailThread.findUniqueOrThrow({ where: { id: threadOfB } })).contactId).toBe(b);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.body.id } })).contactId).toBe(b);
    const restoredA = await admin.get(`/contacts/${a}`);
    expect(restoredA.body.emails).toHaveLength(1);
    expect(restoredA.body.country).toBeNull();
    const restoredB = await admin.get(`/contacts/${b}`);
    expect(restoredB.body.id).toBe(b);
    expect(restoredB.body.primaryEmail).toBe(`ravi.kumar@gmail-alt-${stamp}.com`);
    expect((await admin.post(`/contact-merges/${done.body.mergeIds[0]}/undo`)).status).toBe(409);
    expect(await prisma.auditLog.count({ where: { action: 'contact.merge.undo', entityId: a } })).toBe(1);
  });
});

describe('lead routing and the pipeline', () => {
  let leadId: string;
  let enquiry: { id: string };
  let owner: string;

  beforeAll(async () => {
    const team = await prisma.team.create({ data: { id: newId(), name: `Sales ${stamp}`, departmentId: salesDept.id } });
    for (const k of ['rep1', 'rep2']) await prisma.teamMember.create({ data: { teamId: team.id, userId: people[k]!.id, inRotation: true } });
    const rule = await admin.post('/assignment-rules', {
      name: 'Website enquiries',
      conditions: { match: 'all', conditions: [{ field: 'mailbox', op: 'is', value: ids[sales] }, { field: 'subject', op: 'contains', value: 'quote' }] },
      targetType: 'TEAM',
      teamId: team.id,
      strategy: 'ROUND_ROBIN',
      createLead: true,
      leadServiceInterest: 'SEO',
    });
    expect(rule.status).toBe(201);
    expect(rule.body.createLead).toBe(true);
  });

  it('a matching enquiry becomes a lead for the salesperson the rule picks, with a notification and a follow-up task', async () => {
    enquiry = await receive(sales, { from: `"Meera Iyer" <meera@iyer-${stamp}.com>`, subject: 'Need a quote for SEO' });
    const t = await prisma.emailThread.findUniqueOrThrow({ where: { id: enquiry.id } });
    owner = t.assigneeId!;
    expect([people.rep1!.id, people.rep2!.id]).toContain(owner);
    const lead = await prisma.lead.findFirstOrThrow({ where: { sourceThreadId: enquiry.id }, include: { tasks: true, contact: true } });
    leadId = lead.id;
    expect(lead).toMatchObject({ status: 'NEW', source: 'INBOUND_EMAIL', ownerId: owner, departmentId: salesDept.id, serviceInterest: 'SEO', title: 'Need a quote for SEO' });
    expect(lead.contact.type).toBe('PROSPECT');
    expect(lead.tasks).toHaveLength(1);
    expect(lead.tasks[0]).toMatchObject({ assigneeId: owner, threadId: enquiry.id, status: 'OPEN' });
    expect(lead.tasks[0]!.dueAt!.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    const n = await prisma.notification.findFirst({ where: { userId: owner, type: 'LEAD_ASSIGNED' } });
    expect(n?.title).toBe('New lead: Need a quote for SEO');
    expect((n?.data as { url: string }).url).toBe(`/leads?lead=${leadId}`);
    // A second email from the same person (new thread) does not open a second lead.
    await receive(sales, { from: `meera@iyer-${stamp}.com`, subject: 'Another quote request' });
    expect(await prisma.lead.count({ where: { contactId: lead.contactId } })).toBe(1);
    // Mail that does not match the rule creates no lead.
    const other = await receive(sales, { from: `x@nolead-${stamp}.com`, subject: 'Hello' });
    expect(await prisma.lead.count({ where: { sourceThreadId: other.id } })).toBe(0);
  });

  it('only the owner (OWN scope) and the department see the lead', async () => {
    const ownerClient = owner === people.rep1!.id ? as.rep1! : as.rep2!;
    const otherRep = owner === people.rep1!.id ? as.rep2! : as.rep1!;
    expect((await ownerClient.get(`/leads/${leadId}`)).status).toBe(200);
    expect((await otherRep.get(`/leads/${leadId}`)).status).toBe(404);
    expect((await as.mgr!.get(`/leads/${leadId}`)).status).toBe(200);
    expect((await otherRep.get('/leads')).body.map((l: { id: string }) => l.id)).not.toContain(leadId);
    expect((await otherRep.post(`/leads/${leadId}/status`, { status: 'WON' })).status).toBe(404);
  });

  it('our reply moves it to Contacted; stages are recorded; Lost needs a reason; Won makes a client', async () => {
    const providerThreadId = (await prisma.emailThread.findUniqueOrThrow({ where: { id: enquiry.id } })).providerThreadId!;
    fake.gmailAdd(sales, gmailMessage(sales, `reply-${stamp}`, { threadId: providerThreadId, from: sales, to: `meera@iyer-${stamp}.com`, labelIds: ['SENT'], date: new Date(), subject: 'Re: Need a quote for SEO' }));
    await sync.run(ids[sales]!, 'WEBHOOK');
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: leadId } })).status).toBe('CONTACTED');

    const mgr = as.mgr!;
    expect((await mgr.post(`/leads/${leadId}/status`, { status: 'PROPOSAL_SENT', note: 'Sent the SEO proposal' })).status).toBe(201);
    expect((await mgr.put(`/leads/${leadId}`, { estimatedValue: 2500, currency: 'usd' })).body.estimatedValue).toBe('2500.00');
    const lost = await mgr.post(`/leads/${leadId}/status`, { status: 'LOST' });
    expect(lost.status).toBe(422);
    const won = await mgr.post(`/leads/${leadId}/status`, { status: 'WON' });
    expect(won.status).toBe(201);
    expect(won.body.wonAt).toBeTruthy();
    expect(won.body.history.map((h: { to: string }) => h.to)).toEqual(['WON', 'PROPOSAL_SENT', 'CONTACTED', 'NEW']);
    expect(won.body.history[2].note).toBe('Reply sent');
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: leadId }, include: { contact: true } });
    expect(lead.contact.type).toBe('CLIENT');

    const summary = await mgr.get('/leads/summary');
    expect(summary.body.won).toBeGreaterThanOrEqual(1);
    expect(summary.body.wonValue).toEqual(expect.arrayContaining([{ currency: 'USD', value: '2500.00' }]));
    expect(summary.body.conversionRate).toBeGreaterThan(0);
  });

  it('a salesperson creates a lead from a conversation by hand, once', async () => {
    const t = await receive(sales, { from: `"Hand Made" <hand@hand-${stamp}.com>`, subject: 'Partnership' });
    await admin.post(`/threads/${t.id}/assign`, { assigneeId: people.rep2!.id });
    const panel = await as.rep2!.get(`/threads/${t.id}/crm`);
    expect(panel.body.canCreateLead).toBe(true);
    const r = await as.rep2!.post('/leads', { threadId: t.id, serviceInterest: 'PPC' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ owner: { id: people.rep2!.id }, source: 'INBOUND_EMAIL', title: 'Partnership', serviceInterest: 'PPC', openTasks: 1 });
    // The salesperson created it for themselves: no notification to themselves.
    expect(await prisma.notification.count({ where: { userId: people.rep2!.id, type: 'LEAD_ASSIGNED', data: { path: ['url'], equals: `/leads?lead=${r.body.id}` } } })).toBe(0);
    expect((await as.rep2!.post('/leads', { threadId: t.id })).body.error.code).toBe('LEAD_EXISTS');
    // OWN scope cannot give the lead to a colleague.
    expect((await as.rep2!.put(`/leads/${r.body.id}`, { ownerId: people.rep1!.id })).status).toBe(422);
    // The manager can, and the new owner is told.
    expect((await as.mgr!.put(`/leads/${r.body.id}`, { ownerId: people.rep1!.id })).status).toBe(200);
    expect(await prisma.notification.count({ where: { userId: people.rep1!.id, type: 'LEAD_ASSIGNED', title: 'New lead: Partnership' } })).toBe(1);
  });
});

describe('tasks', () => {
  it('assigning, visibility, completion and the due reminder', async () => {
    // OWN-scope employees can only give tasks to themselves.
    expect((await as.emp!.post('/tasks', { title: 'Nope', assigneeId: people.emp2!.id })).status).toBe(422);
    const mine = await as.emp!.post('/tasks', { title: 'Prepare report', dueAt: daysAgo(-1).toISOString() });
    expect(mine.status).toBe(201);
    expect(mine.body.assignee.id).toBe(people.emp!.id);
    expect((await as.emp2!.get(`/tasks/${mine.body.id}`)).status).toBe(404);

    const given = await as.mgr!.post('/tasks', { title: 'Call the client back', assigneeId: people.rep1!.id, dueAt: new Date(Date.now() - 60_000).toISOString() });
    expect(given.status).toBe(201);
    expect(await prisma.notification.count({ where: { userId: people.rep1!.id, type: 'TASK_ASSIGNED', title: 'New task: Call the client back' } })).toBe(1);
    expect((await as.rep1!.get('/tasks?view=mine')).body.map((t: { id: string }) => t.id)).toContain(given.body.id);

    // The worker's sweep reminds once.
    const worker = app.get(TasksService);
    expect(await worker.dueSweep(new Date())).toBeGreaterThanOrEqual(1);
    await worker.dueSweep(new Date());
    expect(await prisma.notification.count({ where: { userId: people.rep1!.id, type: 'TASK_DUE', title: 'Task due: Call the client back' } })).toBe(1);
    // A new due time gets a new reminder.
    await as.rep1!.put(`/tasks/${given.body.id}`, { dueAt: new Date(Date.now() - 1000).toISOString() });
    await worker.dueSweep(new Date());
    expect(await prisma.notification.count({ where: { userId: people.rep1!.id, type: 'TASK_DUE', title: 'Task due: Call the client back' } })).toBe(2);

    const done = await as.rep1!.post(`/tasks/${given.body.id}/complete`);
    expect(done.body.status).toBe('DONE');
    expect(done.body.completedAt).toBeTruthy();
    expect((await as.rep1!.post(`/tasks/${given.body.id}/reopen`)).body.status).toBe('OPEN');
    // Someone outside cannot change it.
    expect((await as.emp!.post(`/tasks/${given.body.id}/complete`)).status).toBe(404);
  });

  it('a task links to its conversation only for people who can read the conversation', async () => {
    const t = await receive(support, { from: `link@link-${stamp}.com` });
    const r = await admin.post('/tasks', { title: 'Linked', threadId: t.id, assigneeId: people.emp!.id });
    expect(r.status).toBe(201);
    expect(r.body.thread.id).toBe(t.id);
    expect(r.body.contact).toBeTruthy();
    const seen = await as.emp!.get(`/tasks/${r.body.id}`);
    expect(seen.body.thread).toBeNull();
    expect((await as.emp!.post('/tasks', { title: 'x', threadId: t.id })).status).toBe(404);
  });

});
