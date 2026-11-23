import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@crm/db';
import { newId } from '@crm/crypto';
import { AccessPolicy } from '../src/access/access-policy.service';
import { PermissionService } from '../src/access/permission.service';
import { dbContext, PrismaService } from '../src/prisma/prisma.service';
import type { RequestContext } from '../src/common/request-context';
import { bootApp, clientAs, makeDepartment, makeUser, prisma } from './helpers';

/**
 * Phase 10: Postgres Row-Level Security as a second layer (docs/05 §5). The database itself must
 * hide conversations, messages, attachments, notes and AI summaries the caller may not read, even
 * when application code forgets its access filter.
 */
let app: INestApplication;
let db: PrismaService;
let access: AccessPolicy;
let perms: PermissionService;
const stamp = Date.now().toString(36);
const u: Record<string, { id: string }> = {};
const acc: Record<string, string> = {};
const th: Record<string, string> = {};
const mine = () => Object.values(th);

async function ctxOf(userId: string): Promise<RequestContext> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { role: true } });
  return { userId, sessionId: 'test', roleKey: user.role.key, departmentId: user.departmentId, permissions: await perms.effectiveFor(userId), ip: null, userAgent: null };
}
/** Runs `fn` with the database context the API would set for this employee. */
async function as<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const ctx = await ctxOf(userId);
  return dbContext.run({ userId, scope: ctx.permissions['conversation.read'] ?? '' }, fn);
}
const visibleIds = async (userId: string) =>
  as(userId, async () => (await db.emailThread.findMany({ where: { id: { in: mine() } }, select: { id: true } })).map((t) => t.id).sort());

beforeAll(async () => {
  ({ app } = await bootApp());
  db = app.get(PrismaService);
  access = app.get(AccessPolicy);
  perms = app.get(PermissionService);
  const D = await makeDepartment(`RLS D ${stamp}`);
  const E = await makeDepartment(`RLS E ${stamp}`);
  for (const [k, role, dept] of [
    ['admin', 'SUPER_ADMIN', null],
    ['mgr', 'DEPT_MANAGER', D],
    ['lead', 'TEAM_LEADER', D],
    ['emp1', 'EMPLOYEE', D],
    ['emp2', 'EMPLOYEE', D],
    ['emp3', 'EMPLOYEE', E],
    ['mention', 'EMPLOYEE', E],
    ['granted', 'EMPLOYEE', E],
  ] as const) {
    u[k] = await makeUser({ role, departmentId: dept?.id ?? null, name: `RLS ${k}` });
  }
  await prisma.department.update({ where: { id: D.id }, data: { managerId: u.mgr!.id } });
  const team = await prisma.team.create({ data: { id: newId(), name: `RLS T ${stamp}`, departmentId: D.id, leaderId: u.lead!.id } });
  await prisma.teamMember.create({ data: { teamId: team.id, userId: u.emp1!.id } });
  for (const [k, dept] of [['A', D.id], ['B', E.id], ['G', null]] as const) {
    acc[k] = newId();
    await prisma.emailAccount.create({ data: { id: acc[k]!, provider: 'IMAP', emailAddress: `rls-${k.toLowerCase()}-${stamp}@example.com`, departmentId: dept, status: 'PAUSED', connectedById: u.admin!.id } });
  }
  await prisma.emailAccountAccess.create({ data: { id: newId(), emailAccountId: acc.G!, userId: u.granted!.id, level: 'READ' } });
  const mk = async (key: string, accountId: string, data: Partial<Prisma.EmailThreadUncheckedCreateInput> = {}) => {
    th[key] = newId();
    await prisma.emailThread.create({ data: { id: th[key]!, emailAccountId: accountId, subject: `RLS ${key}`, normalizedSubject: `rls ${key}`, firstMessageAt: new Date(), lastMessageAt: new Date(), ...data } });
    const m = await prisma.emailMessage.create({
      data: { id: newId(), threadId: th[key]!, emailAccountId: accountId, providerMessageId: `rls-${stamp}-${key}`, direction: 'INBOUND', fromAddress: 'c@example.com', toRecipients: [], subject: `RLS ${key}`, bodyText: `secret ${key}`, receivedAt: new Date() },
    });
    await prisma.attachment.create({ data: { id: newId(), messageId: m.id, filename: `${key}.pdf`, contentType: 'application/pdf', sizeBytes: 1 } });
    await prisma.aiSummary.create({ data: { id: newId(), threadId: th[key]!, kind: 'SUMMARY', model: 'x', content: {}, upToMessageId: m.id } });
  };
  await mk('emp1', acc.A!, { assigneeId: u.emp1!.id, departmentId: D.id }); // assigned to emp1 (team member)
  await mk('team', acc.A!, { teamId: team.id, departmentId: D.id }); // team queue
  await mk('emp2', acc.A!, { assigneeId: u.emp2!.id, departmentId: D.id }); // department, not team
  await mk('deptbox', acc.A!); // department mailbox, no department on the thread
  await mk('other', acc.B!, { assigneeId: u.emp3!.id, departmentId: E.id });
  await mk('shared', acc.B!, { departmentId: E.id });
  await mk('mentioned', acc.B!, { departmentId: E.id });
  await mk('granted', acc.G!);
  await prisma.threadShare.create({ data: { threadId: th.shared!, userId: u.emp2!.id, sharedById: u.admin!.id } });
  const note = await prisma.internalNote.create({ data: { id: newId(), threadId: th.mentioned!, authorId: u.admin!.id, body: 'secret note' } });
  await prisma.noteMention.create({ data: { noteId: note.id, userId: u.mention!.id } });
  await prisma.internalNote.create({ data: { id: newId(), threadId: th.emp1!, authorId: u.admin!.id, body: 'note on emp1' } });
});

afterAll(async () => {
  vi.restoreAllMocks();
  await app?.close();
});

describe('Phase 10: Postgres RLS', () => {
  it('the database alone (no application filter) shows each person exactly what AccessPolicy allows', async () => {
    const expected = async (k: string) => {
      const ctx = await ctxOf(u[k]!.id);
      return (await prisma.emailThread.findMany({ where: { AND: [{ id: { in: mine() } }, await access.threadWhere(ctx)] }, select: { id: true } })).map((t) => t.id).sort();
    };
    const name = (ids: string[]) => ids.map((id) => Object.entries(th).find(([, v]) => v === id)![0]).sort();
    const cases: Record<string, string[]> = {
      admin: Object.keys(th),
      mgr: ['deptbox', 'emp1', 'emp2', 'team'],
      lead: ['emp1', 'team'],
      emp1: ['emp1'],
      emp2: ['emp2', 'shared'],
      emp3: ['other'],
      mention: ['mentioned'],
      granted: ['granted'],
    };
    for (const [k, want] of Object.entries(cases)) {
      const rls = await visibleIds(u[k]!.id);
      expect(name(rls), k).toEqual([...want].sort());
      expect(rls, `${k} mirrors AccessPolicy`).toEqual(await expected(k));
    }
  });

  it('messages, attachments, notes and AI summaries follow their conversation', async () => {
    await as(u.emp1!.id, async () => {
      expect((await db.emailMessage.findMany({ where: { emailAccountId: { in: Object.values(acc) } } })).map((m) => m.bodyText)).toEqual(['secret emp1']);
      expect((await db.attachment.findMany({ where: { message: { emailAccountId: { in: Object.values(acc) } } } })).map((a) => a.filename)).toEqual(['emp1.pdf']);
      expect((await db.internalNote.findMany({ where: { threadId: { in: mine() } } })).map((n) => n.body)).toEqual(['note on emp1']);
      expect(await db.aiSummary.count({ where: { threadId: { in: mine() } } })).toBe(1);
    });
  });

  it('raw SQL, batches and interactive transactions are filtered too', async () => {
    await as(u.emp1!.id, async () => {
      const raw = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM email_messages WHERE "threadId" = ANY(${mine()}::text[])`;
      expect(raw[0]!.n).toBe(1);
      const [a, b] = await db.$transaction([db.emailThread.count({ where: { id: { in: mine() } } }), db.emailMessage.count({ where: { threadId: { in: mine() } } })]);
      expect([a, b]).toEqual([1, 1]);
      const inTx = await db.$transaction(async (tx) => [await tx.emailThread.count({ where: { id: { in: mine() } } }), await tx.internalNote.count({ where: { threadId: { in: mine() } } })]);
      expect(inTx).toEqual([1, 1]);
    });
  });

  it('writes cannot touch conversations the caller cannot see', async () => {
    await as(u.emp1!.id, async () => {
      const r = await db.emailThread.updateMany({ where: { id: th.other! }, data: { subject: 'hijacked' } });
      expect(r.count).toBe(0);
      await expect(db.internalNote.create({ data: { id: newId(), threadId: th.other!, authorId: u.emp1!.id, body: 'x' } })).rejects.toThrow(/row-level security/);
    });
    expect((await prisma.emailThread.findUniqueOrThrow({ where: { id: th.other! } })).subject).toBe('RLS other');
  });

  it('fails closed: a request without a signed-in user, or without conversation access, sees nothing', async () => {
    const none = await dbContext.run({ userId: null, scope: '' }, async () => await db.emailThread.count({ where: { id: { in: mine() } } }));
    expect(none).toBe(0);
    const noScope = await dbContext.run({ userId: u.emp1!.id, scope: '' }, async () => await db.emailThread.count({ where: { id: { in: mine() } } }));
    expect(noScope).toBe(0);
    // Work the API does on its own (no request) and the worker's own sessions see everything.
    expect(await db.emailThread.count({ where: { id: { in: mine() } } })).toBe(8);
    expect(await prisma.emailThread.count({ where: { id: { in: mine() } } })).toBe(8);
  });

  it('over HTTP: even if the access filter were forgotten, an employee only gets their own conversations', async () => {
    const c = await clientAs(app, u.emp2!.id);
    vi.spyOn(access, 'threadWhere').mockResolvedValue({}); // simulate the bug RLS exists to catch
    const res = await c.get('/threads?view=all&limit=100');
    expect(res.status).toBe(200);
    const ids = (res.body.items as { id: string }[]).map((t) => t.id).filter((id) => mine().includes(id));
    expect(ids.sort()).toEqual([th.emp2!, th.shared!].sort());
    const other = await c.get(`/threads/${th.other}`);
    expect(other.status).toBe(404);
    vi.restoreAllMocks();
  });
});
