import { Injectable } from '@nestjs/common';
import { Prisma, type ContactType } from '@crm/db';
import { newId } from '@crm/crypto';
import {
  OPEN_LEAD_STATUSES,
  isFreeMailDomain,
  type CompanyView,
  type ContactDetail,
  type ContactListItem,
  type ContactMergeView,
  type ContactTimeline,
  type DuplicatePair,
  type MergePreview,
  type ThreadCrm,
} from '@crm/shared';
import type { z } from 'zod';
import type { companyListQuery, companySchema, contactCreateSchema, contactEmailSchema, contactFieldsSchema, contactListQuery, dismissDuplicateSchema, mergeSchema } from '@crm/shared';
import { AccessPolicy } from '../access/access-policy.service';
import { AuditService, diff } from '../audit/audit.service';
import { Errors } from '../common/errors';
import type { RequestContext } from '../common/request-context';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { ContactLinkService } from './contact-link.service';
import { CrmAccess } from './crm-access';
import { LeadsService } from './leads.service';
import { TasksService, taskInclude } from './tasks.service';

const contactInclude = {
  emails: { select: { id: true, email: true, isPrimary: true }, orderBy: [{ isPrimary: 'desc' }, { email: 'asc' }] },
  company: { select: { id: true, name: true, domain: true } },
  owner: { select: { id: true, name: true } },
  department: { select: { id: true, name: true } },
  tags: { select: { tag: { select: { id: true, name: true, color: true } } } },
} satisfies Prisma.ContactInclude;
type Row = Prisma.ContactGetPayload<{ include: typeof contactInclude }>;

function item(c: Row): ContactListItem {
  return {
    id: c.id,
    name: c.name,
    primaryEmail: c.emails[0]?.email ?? null,
    emailCount: c.emails.length,
    company: c.company,
    type: c.type,
    owner: c.owner,
    phone: c.phone,
    lastContactedAt: c.lastContactedAt?.toISOString() ?? null,
    tags: c.tags.map((t) => t.tag),
  };
}

/** Fields a merge may fill on the surviving contact. */
const MERGE_FIELDS = ['name', 'phone', 'companyId', 'website', 'country', 'ownerId', 'departmentId', 'type', 'notes'] as const;
type MergeField = (typeof MERGE_FIELDS)[number];
type FieldValues = Record<MergeField, string | null>;
const FIELD_LABEL: Record<MergeField, string> = { name: 'Name', phone: 'Phone', companyId: 'Company', website: 'Website', country: 'Country', ownerId: 'Owner', departmentId: 'Department', type: 'Type', notes: 'Notes' };

interface Moved {
  emailIds: string[];
  primaryEmailId: string | null;
  threadIds: string[];
  leadIds: string[];
  taskIds: string[];
  /** Tags the target did not have before the merge. */
  tagIds: string[];
}
type Changes = Partial<Record<MergeField, { before: string | null; after: string | null }>>;

const empty = (f: MergeField, v: string | null) => v === null || v === '' || (f === 'type' && v === 'OTHER');
const OPEN = [...OPEN_LEAD_STATUSES];

/**
 * Contacts and companies: the list, the card, the timeline, manual edits, duplicate detection
 * and merging. Merges never delete: the merged contact is hidden (`mergedIntoId`) and every row
 * that moved is recorded in `contact_merges`, so an administrator can undo it.
 */
@Injectable()
export class ContactsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessPolicy,
    private readonly crm: CrmAccess,
    private readonly audit: AuditService,
    private readonly link: ContactLinkService,
    private readonly leads: LeadsService,
    private readonly tasks: TasksService,
  ) {}

  // ───────────── reading ─────────────

  async list(ctx: RequestContext, q: z.infer<typeof contactListQuery>) {
    const and: Prisma.ContactWhereInput[] = [await this.crm.contactWhere(ctx)];
    if (q.type) and.push({ type: q.type });
    if (q.ownerId) and.push({ ownerId: q.ownerId });
    if (q.companyId) and.push({ companyId: q.companyId });
    if (q.q) {
      const s = { contains: q.q, mode: 'insensitive' as const };
      and.push({ OR: [{ name: s }, { emails: { some: { email: s } } }, { company: { name: s } }, { phone: { contains: q.q } }] });
    }
    const where = { AND: and };
    const [total, rows] = await Promise.all([
      this.prisma.contact.count({ where }),
      this.prisma.contact.findMany({
        where,
        include: contactInclude,
        orderBy: [{ lastContactedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
    ]);
    return { items: rows.map(item), total, page: q.page, limit: q.limit };
  }

  private async visible(ctx: RequestContext, id: string) {
    const live = await this.link.live(id);
    const c = await this.prisma.contact.findFirst({ where: { AND: [{ id: live }, await this.crm.contactWhere(ctx)] }, include: contactInclude });
    if (!c) throw Errors.notFound('Contact');
    return c;
  }

  private async canEdit(ctx: RequestContext, id: string) {
    if (!ctx.permissions['contact.write']) return false;
    return (await this.prisma.contact.count({ where: { AND: [{ id }, await this.crm.contactWhere(ctx, 'contact.write')] } })) > 0;
  }

  private async editable(ctx: RequestContext, id: string) {
    const c = await this.visible(ctx, id);
    if (!(await this.canEdit(ctx, c.id))) throw Errors.forbidden('You cannot change this contact');
    return c;
  }

  /** A merged contact's id opens the contact it was merged into. */
  async get(ctx: RequestContext, id: string): Promise<ContactDetail> {
    const c = await this.visible(ctx, id);
    const canMerge = !!ctx.permissions['contact.merge'];
    const full = await this.prisma.contact.findUniqueOrThrow({ where: { id: c.id }, select: { website: true, country: true, notes: true, createdAt: true } });
    return {
      ...item(c),
      emails: c.emails,
      website: full.website,
      country: full.country,
      department: c.department,
      notes: full.notes,
      createdAt: full.createdAt.toISOString(),
      canEdit: await this.canEdit(ctx, c.id),
      canMerge,
      merges: canMerge ? await this.mergeHistory(c.id) : [],
    };
  }

  private async mergeHistory(targetId: string): Promise<ContactMergeView[]> {
    const rows = await this.prisma.contactMerge.findMany({
      where: { targetId },
      orderBy: { createdAt: 'desc' },
      include: { source: { select: { id: true, name: true } } },
      take: 50,
    });
    const names = new Map((await this.prisma.user.findMany({ where: { id: { in: rows.flatMap((r) => (r.mergedById ? [r.mergedById] : [])) } }, select: { id: true, name: true } })).map((u) => [u.id, u]));
    return Promise.all(
      rows.map(async (r) => {
        const m = r.moved as unknown as Moved;
        const emails = await this.prisma.contactEmail.findMany({ where: { id: { in: m.emailIds } }, select: { email: true } });
        return {
          id: r.id,
          source: { id: r.source.id, name: r.source.name, emails: emails.map((e) => e.email) },
          mergedBy: r.mergedById ? (names.get(r.mergedById) ?? null) : null,
          createdAt: r.createdAt.toISOString(),
          undoneAt: r.undoneAt?.toISOString() ?? null,
          moved: { emails: m.emailIds.length, threads: m.threadIds.length, leads: m.leadIds.length, tasks: m.taskIds.length, tags: m.tagIds.length },
        };
      }),
    );
  }

  /** Every conversation, lead and task with this contact that the caller may see. */
  async timeline(ctx: RequestContext, id: string): Promise<ContactTimeline> {
    const c = await this.visible(ctx, id);
    const threads = ctx.permissions['conversation.read']
      ? await this.prisma.emailThread.findMany({
          where: { AND: [{ contactId: c.id }, await this.access.threadWhere(ctx)] },
          select: { id: true, subject: true, status: true, messageCount: true, lastMessageAt: true, assignee: { select: { id: true, name: true } }, emailAccount: { select: { emailAddress: true } } },
          orderBy: { lastMessageAt: 'desc' },
          take: 200,
        })
      : [];
    const tasks = await this.prisma.task.findMany({ where: { AND: [{ contactId: c.id }, await this.crm.taskWhere(ctx)] }, include: taskInclude, orderBy: [{ status: 'asc' }, { dueAt: { sort: 'asc', nulls: 'last' } }], take: 200 });
    return {
      threads: threads.map((t) => ({ id: t.id, subject: t.subject, mailbox: t.emailAccount.emailAddress, status: t.status, messageCount: t.messageCount, lastMessageAt: t.lastMessageAt.toISOString(), assignee: t.assignee })),
      leads: ctx.permissions['lead.read'] ? await this.leads.listFor(ctx, { contactId: c.id }) : [],
      tasks: await this.tasks.views(ctx, tasks),
    };
  }

  ownerOptions(ctx: RequestContext) {
    return this.crm.people(ctx, 'contact.write');
  }

  // ───────────── writing ─────────────

  /** Owner and department must stay within the caller's reach, or the contact would disappear from their view. */
  private async assertPlacement(ctx: RequestContext, ownerId: string | null, departmentId: string | null) {
    const scope = ctx.permissions['contact.write'];
    if (ownerId && !(await this.crm.canHandTo(ctx, 'contact.write', ownerId))) throw Errors.validation([{ path: 'ownerId', message: 'You cannot give contacts to this person' }]);
    if (scope === 'ALL') {
      if (departmentId && !(await this.prisma.department.count({ where: { id: departmentId } }))) throw Errors.validation([{ path: 'departmentId', message: 'Unknown department' }]);
      return;
    }
    const mine = await this.access.departmentIds(ctx);
    if (departmentId && !mine.includes(departmentId)) throw Errors.validation([{ path: 'departmentId', message: 'Choose one of your departments' }]);
    if (!ownerId && !(scope === 'DEPARTMENT' && departmentId)) throw Errors.validation([{ path: 'ownerId', message: 'Choose who owns the contact' }]);
  }

  private async assertCompany(companyId: string | null | undefined) {
    if (companyId && !(await this.prisma.company.count({ where: { id: companyId } }))) throw Errors.validation([{ path: 'companyId', message: 'Unknown company' }]);
  }

  private async assertFreeEmails(emails: string[]) {
    const taken = await this.prisma.contactEmail.findMany({ where: { email: { in: emails } }, select: { email: true } });
    if (taken.length) throw Errors.conflict(`${taken[0]!.email} already belongs to another contact. Merge the two contacts instead.`, 'EMAIL_IN_USE');
  }

  async create(ctx: RequestContext, input: z.infer<typeof contactCreateSchema>) {
    const emails = [...new Set(input.emails)];
    const ownerId = input.ownerId === undefined ? ctx.userId : input.ownerId;
    const departmentId = input.departmentId === undefined ? ctx.departmentId : input.departmentId;
    await this.assertPlacement(ctx, ownerId, departmentId);
    await this.assertCompany(input.companyId);
    await this.assertFreeEmails(emails);
    const id = newId();
    const data = { name: input.name ?? null, phone: input.phone ?? null, companyId: input.companyId ?? null, website: input.website ?? null, country: input.country ?? null, type: (input.type ?? 'OTHER') as ContactType, ownerId, departmentId, notes: input.notes ?? null };
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.contact.create({ data: { id, ...data } });
        await tx.contactEmail.createMany({ data: emails.map((email, i) => ({ id: newId(), contactId: id, email, isPrimary: i === 0 })) });
        await this.audit.record(tx, ctx, { action: 'contact.create', entityType: 'Contact', entityId: id, after: { ...data, emails } });
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw Errors.conflict('This email address already belongs to another contact', 'EMAIL_IN_USE');
      throw e;
    }
    return this.get(ctx, id);
  }

  async update(ctx: RequestContext, id: string, input: z.infer<typeof contactFieldsSchema>) {
    const c = await this.editable(ctx, id);
    const before = await this.prisma.contact.findUniqueOrThrow({ where: { id: c.id } });
    const data: Prisma.ContactUncheckedUpdateInput = {};
    for (const k of ['name', 'phone', 'companyId', 'website', 'country', 'type', 'ownerId', 'departmentId', 'notes'] as const) if (input[k] !== undefined) (data as Record<string, unknown>)[k] = input[k];
    if (input.ownerId !== undefined || input.departmentId !== undefined) {
      const ownerId = input.ownerId === undefined ? before.ownerId : input.ownerId;
      const departmentId = input.departmentId === undefined ? before.departmentId : input.departmentId;
      if (ownerId !== before.ownerId || departmentId !== before.departmentId) await this.assertPlacement(ctx, ownerId, departmentId);
    }
    await this.assertCompany(input.companyId);
    await this.prisma.$transaction(async (tx) => {
      await tx.contact.update({ where: { id: c.id }, data });
      const d = diff(before as unknown as Record<string, unknown>, data as Record<string, unknown>);
      if (d.changed) await this.audit.record(tx, ctx, { action: 'contact.update', entityType: 'Contact', entityId: c.id, before: d.before, after: d.after });
    });
    return this.get(ctx, c.id);
  }

  async addEmail(ctx: RequestContext, id: string, input: z.infer<typeof contactEmailSchema>) {
    const c = await this.editable(ctx, id);
    await this.assertFreeEmails([input.email]);
    try {
      await this.prisma.$transaction(async (tx) => {
        if (input.isPrimary) await tx.contactEmail.updateMany({ where: { contactId: c.id }, data: { isPrimary: false } });
        await tx.contactEmail.create({ data: { id: newId(), contactId: c.id, email: input.email, isPrimary: input.isPrimary || c.emails.length === 0 } });
        await this.audit.record(tx, ctx, { action: 'contact.email.add', entityType: 'Contact', entityId: c.id, after: { email: input.email } });
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw Errors.conflict('This email address already belongs to another contact', 'EMAIL_IN_USE');
      throw e;
    }
    return this.get(ctx, c.id);
  }

  async removeEmail(ctx: RequestContext, id: string, emailId: string) {
    const c = await this.editable(ctx, id);
    const e = c.emails.find((x) => x.id === emailId);
    if (!e) throw Errors.notFound('Email address');
    if (c.emails.length === 1) throw Errors.conflict('A contact needs at least one email address', 'LAST_EMAIL');
    await this.prisma.$transaction(async (tx) => {
      await tx.contactEmail.delete({ where: { id: emailId } });
      if (e.isPrimary) await tx.contactEmail.update({ where: { id: c.emails.find((x) => x.id !== emailId)!.id }, data: { isPrimary: true } });
      await this.audit.record(tx, ctx, { action: 'contact.email.remove', entityType: 'Contact', entityId: c.id, before: { email: e.email } });
    });
    return this.get(ctx, c.id);
  }

  async setPrimaryEmail(ctx: RequestContext, id: string, emailId: string) {
    const c = await this.editable(ctx, id);
    if (!c.emails.some((x) => x.id === emailId)) throw Errors.notFound('Email address');
    await this.prisma.$transaction([
      this.prisma.contactEmail.updateMany({ where: { contactId: c.id }, data: { isPrimary: false } }),
      this.prisma.contactEmail.update({ where: { id: emailId }, data: { isPrimary: true } }),
    ]);
    return this.get(ctx, c.id);
  }

  async setTags(ctx: RequestContext, id: string, tagIds: string[]) {
    const c = await this.editable(ctx, id);
    const ids = [...new Set(tagIds)];
    if ((await this.prisma.tag.count({ where: { id: { in: ids } } })) !== ids.length) throw Errors.validation([{ path: 'tagIds', message: 'Unknown tag' }]);
    await this.prisma.$transaction(async (tx) => {
      await tx.contactTag.deleteMany({ where: { contactId: c.id, tagId: { notIn: ids } } });
      await tx.contactTag.createMany({ data: ids.map((tagId) => ({ contactId: c.id, tagId })), skipDuplicates: true });
      await this.audit.record(tx, ctx, { action: 'contact.tags', entityType: 'Contact', entityId: c.id, before: c.tags.map((t) => t.tag.id), after: ids });
    });
    return this.get(ctx, c.id);
  }

  // ───────────── the conversation's CRM panel ─────────────

  async forThread(ctx: RequestContext, threadId: string): Promise<ThreadCrm> {
    if (!(await this.crm.threadReadable(ctx, threadId))) throw Errors.notFound('Conversation');
    const t = await this.prisma.emailThread.findUniqueOrThrow({ where: { id: threadId }, select: { contactId: true } });
    let contact: ThreadCrm['contact'] = null;
    if (t.contactId && ctx.permissions['contact.read']) {
      const live = await this.link.live(t.contactId);
      const c = await this.prisma.contact.findFirst({ where: { AND: [{ id: live }, await this.crm.contactWhere(ctx)] }, include: contactInclude });
      if (c) contact = { ...item(c), canEdit: await this.canEdit(ctx, c.id) };
    }
    const leads = ctx.permissions['lead.read']
      ? await this.leads.listFor(ctx, { OR: [{ sourceThreadId: threadId }, ...(contact ? [{ contactId: contact.id, status: { in: OPEN } }] : [])] })
      : [];
    const taskRows = ctx.permissions['task.read'] ? await this.prisma.task.findMany({ where: { AND: [{ threadId }, await this.crm.taskWhere(ctx)] }, include: taskInclude, orderBy: [{ status: 'asc' }, { dueAt: { sort: 'asc', nulls: 'last' } }] }) : [];
    return {
      contact,
      leads,
      tasks: await this.tasks.views(ctx, taskRows),
      canCreateLead: !!ctx.permissions['lead.write'] && !!t.contactId && !(await this.prisma.lead.count({ where: { sourceThreadId: threadId, status: { in: OPEN } } })),
      canCreateTask: !!ctx.permissions['task.write'],
    };
  }

  // ───────────── companies ─────────────

  private async companyViews(ctx: RequestContext, where: Prisma.CompanyWhereInput, take: number): Promise<CompanyView[]> {
    const [cw, lw] = await Promise.all([this.crm.contactWhere(ctx), this.crm.leadWhere(ctx)]);
    const rows = await this.prisma.company.findMany({
      where,
      orderBy: { name: 'asc' },
      take,
      include: { _count: { select: { contacts: { where: cw }, leads: { where: { AND: [lw, { status: { in: OPEN } }] } } } } },
    });
    return rows.map((c) => ({ id: c.id, name: c.name, domain: c.domain, website: c.website, country: c.country, contactCount: c._count.contacts, openLeadCount: c._count.leads }));
  }

  async companies(ctx: RequestContext, q: z.infer<typeof companyListQuery>) {
    const s = q.q ? { contains: q.q, mode: 'insensitive' as const } : null;
    return this.companyViews(ctx, s ? { OR: [{ name: s }, { domain: s }] } : {}, q.limit);
  }

  async company(ctx: RequestContext, id: string) {
    const [c] = await this.companyViews(ctx, { id }, 1);
    if (!c) throw Errors.notFound('Company');
    const contacts = await this.prisma.contact.findMany({ where: { AND: [{ companyId: id }, await this.crm.contactWhere(ctx)] }, include: contactInclude, orderBy: { name: 'asc' }, take: 200 });
    return { ...c, contacts: contacts.map(item), leads: ctx.permissions['lead.read'] ? await this.leads.listFor(ctx, { companyId: id }) : [] };
  }

  private async assertDomain(domain: string | null | undefined, exceptId?: string) {
    if (!domain) return;
    if (isFreeMailDomain(domain)) throw Errors.validation([{ path: 'domain', message: 'Free email providers (like gmail.com) cannot be a company domain' }]);
    const other = await this.prisma.company.findUnique({ where: { domain }, select: { id: true } });
    if (other && other.id !== exceptId) throw Errors.conflict('Another company already has this domain', 'DOMAIN_IN_USE');
  }

  async createCompany(ctx: RequestContext, input: z.infer<typeof companySchema>) {
    await this.assertDomain(input.domain);
    const id = newId();
    const data = { name: input.name, domain: input.domain ?? null, website: input.website ?? null, country: input.country ?? null };
    await this.prisma.$transaction(async (tx) => {
      await tx.company.create({ data: { id, ...data } });
      await this.audit.record(tx, ctx, { action: 'company.create', entityType: 'Company', entityId: id, after: data });
    });
    return this.company(ctx, id);
  }

  async updateCompany(ctx: RequestContext, id: string, input: z.infer<typeof companySchema>) {
    const before = await this.prisma.company.findUnique({ where: { id } });
    if (!before) throw Errors.notFound('Company');
    await this.assertDomain(input.domain, id);
    const data = { name: input.name, domain: input.domain ?? null, website: input.website ?? null, country: input.country ?? null };
    await this.prisma.$transaction(async (tx) => {
      await tx.company.update({ where: { id }, data });
      const d = diff(before as unknown as Record<string, unknown>, data);
      if (d.changed) await this.audit.record(tx, ctx, { action: 'company.update', entityType: 'Company', entityId: id, before: d.before, after: d.after });
    });
    return this.company(ctx, id);
  }

  // ───────────── duplicates ─────────────

  /**
   * Likely duplicates among live contacts, best first: the same phone number; a similar name at
   * the same company; the same full name; the same mailbox name at another domain. Pairs an
   * administrator marked as different people are left out.
   */
  async duplicates(limit = 100): Promise<DuplicatePair[]> {
    const rows = await this.prisma.$queryRaw<{ a: string; b: string; score: number; reasons: string[] }[]>(Prisma.sql`
      WITH live AS (
        SELECT id, name, phone, "companyId" FROM contacts WHERE "mergedIntoId" IS NULL
      ), pairs AS (
        SELECT a.id AS a, b.id AS b, 0.9::float8 AS score, 'Same phone number' AS reason
          FROM live a JOIN live b ON a.id < b.id
           AND right(regexp_replace(a.phone, '\\D', '', 'g'), 10) = right(regexp_replace(b.phone, '\\D', '', 'g'), 10)
         WHERE length(regexp_replace(coalesce(a.phone, ''), '\\D', '', 'g')) >= 7
        UNION ALL
        SELECT a.id, b.id, similarity(a.name, b.name)::float8, 'Similar name at the same company'
          FROM live a JOIN live b ON a.id < b.id AND a."companyId" = b."companyId"
         WHERE a.name IS NOT NULL AND b.name IS NOT NULL AND similarity(a.name, b.name) >= 0.5
        UNION ALL
        SELECT a.id, b.id, (similarity(a.name, b.name) * 0.8)::float8, 'Same name'
          FROM live a JOIN live b ON a.id < b.id AND a.name % b.name
         WHERE a.name ~ '\\s' AND length(a.name) >= 5 AND similarity(a.name, b.name) >= 0.8
        UNION ALL
        SELECT ea."contactId", eb."contactId", 0.6::float8, 'Same email name at another domain'
          FROM contact_emails ea
          JOIN contact_emails eb ON ea."contactId" < eb."contactId"
           AND split_part(ea.email, '@', 1) = split_part(eb.email, '@', 1)
          JOIN live la ON la.id = ea."contactId"
          JOIN live lb ON lb.id = eb."contactId"
         WHERE length(split_part(ea.email, '@', 1)) >= 6
           AND split_part(ea.email, '@', 1) !~ '^(info|sales|contact|admin|support|hello|office|enquiries|enquiry|accounts|billing|marketing|careers|jobs|team)$'
      )
      SELECT p.a, p.b, max(p.score) AS score, array_agg(DISTINCT p.reason) AS reasons
        FROM pairs p
       WHERE NOT EXISTS (SELECT 1 FROM contact_duplicate_dismissals d WHERE d."aId" = least(p.a, p.b) AND d."bId" = greatest(p.a, p.b))
       GROUP BY p.a, p.b
       ORDER BY max(p.score) DESC, p.a
       LIMIT ${limit}`);
    if (!rows.length) return [];
    const contacts = await this.prisma.contact.findMany({ where: { id: { in: rows.flatMap((r) => [r.a, r.b]) } }, include: contactInclude });
    const by = new Map(contacts.map((c) => [c.id, item(c)]));
    return rows.filter((r) => by.has(r.a) && by.has(r.b)).map((r) => ({ a: by.get(r.a)!, b: by.get(r.b)!, score: Math.round(Number(r.score) * 100) / 100, reasons: r.reasons }));
  }

  async dismissDuplicate(ctx: RequestContext, input: z.infer<typeof dismissDuplicateSchema>) {
    const [aId, bId] = [input.aId, input.bId].sort() as [string, string];
    if ((await this.prisma.contact.count({ where: { id: { in: [aId, bId] } } })) !== 2) throw Errors.notFound('Contact');
    await this.prisma.$transaction(async (tx) => {
      await tx.contactDuplicateDismissal.createMany({ data: [{ aId, bId, dismissedById: ctx.userId }], skipDuplicates: true });
      await this.audit.record(tx, ctx, { action: 'contact.duplicate.dismiss', entityType: 'Contact', entityId: aId, metadata: { aId, bId } });
    });
  }

  // ───────────── merging ─────────────

  private async values(db: Tx, id: string): Promise<FieldValues> {
    const c = await db.contact.findUniqueOrThrow({ where: { id } });
    return Object.fromEntries(MERGE_FIELDS.map((f) => [f, (c[f] as string | null) ?? null])) as FieldValues;
  }

  /** What merging `source` into a target with values `target` changes on the target. */
  private plan(target: FieldValues, source: FieldValues, sourceLabel: string) {
    const changes: Changes = {};
    const conflicts: { field: MergeField; kept: string; dropped: string }[] = [];
    for (const f of MERGE_FIELDS) {
      const t = target[f];
      const s = source[f];
      if (empty(f, s)) continue;
      if (empty(f, t)) changes[f] = { before: t, after: s };
      else if (f === 'notes' && t !== s) changes[f] = { before: t, after: `${t}\n\n— From ${sourceLabel} —\n${s}` };
      else if (t !== s) conflicts.push({ field: f, kept: t!, dropped: s! });
    }
    return { changes, conflicts };
  }

  /** Readable values for ids (company, owner, department) in the preview. */
  private async label(field: MergeField, v: string) {
    if (field === 'companyId') return (await this.prisma.company.findUnique({ where: { id: v }, select: { name: true } }))?.name ?? v;
    if (field === 'ownerId') return (await this.prisma.user.findUnique({ where: { id: v }, select: { name: true } }))?.name ?? v;
    if (field === 'departmentId') return (await this.prisma.department.findUnique({ where: { id: v }, select: { name: true } }))?.name ?? v;
    return field === 'notes' && v.length > 120 ? `${v.slice(0, 120)}…` : v;
  }

  async merge(ctx: RequestContext, targetId: string, input: z.infer<typeof mergeSchema>): Promise<MergePreview> {
    const sourceIds = [...new Set(input.sourceContactIds)];
    if (sourceIds.includes(targetId)) throw Errors.validation([{ path: 'sourceContactIds', message: 'A contact cannot be merged into itself' }]);
    const all = await this.prisma.contact.findMany({ where: { id: { in: [targetId, ...sourceIds] } }, include: contactInclude });
    const target = all.find((c) => c.id === targetId);
    if (!target) throw Errors.notFound('Contact');
    if (target.mergedIntoId) throw Errors.conflict('This contact was itself merged into another one', 'ALREADY_MERGED');
    const sources = sourceIds.map((id) => all.find((c) => c.id === id));
    if (sources.some((s) => !s)) throw Errors.notFound('Contact');
    if (sources.some((s) => s!.mergedIntoId)) throw Errors.conflict('One of the contacts was already merged', 'ALREADY_MERGED');

    // The same plan drives the preview and the commit.
    const build = async (db: Tx) => {
      let current = await this.values(db, targetId);
      const targetTags = new Set((await db.contactTag.findMany({ where: { contactId: targetId }, select: { tagId: true } })).map((t) => t.tagId));
      const steps: { sourceId: string; moved: Moved; changes: Changes }[] = [];
      const fills: MergePreview['fills'] = [];
      const conflicts: MergePreview['conflicts'] = [];
      for (const s of sources as Row[]) {
        const label = s.name ?? s.emails[0]?.email ?? 'merged contact';
        const p = this.plan(current, await this.values(db, s.id), label);
        current = { ...current, ...Object.fromEntries(Object.entries(p.changes).map(([k, v]) => [k, v!.after])) };
        for (const [f, v] of Object.entries(p.changes) as [MergeField, { after: string }][]) fills.push({ field: FIELD_LABEL[f], value: await this.label(f, v.after) });
        for (const c of p.conflicts) conflicts.push({ field: FIELD_LABEL[c.field], kept: await this.label(c.field, c.kept), dropped: await this.label(c.field, c.dropped) });
        const [emails, threads, leads, tasks, tags] = await Promise.all([
          db.contactEmail.findMany({ where: { contactId: s.id }, select: { id: true, isPrimary: true } }),
          db.emailThread.findMany({ where: { contactId: s.id }, select: { id: true } }),
          db.lead.findMany({ where: { contactId: s.id }, select: { id: true } }),
          db.task.findMany({ where: { contactId: s.id }, select: { id: true } }),
          db.contactTag.findMany({ where: { contactId: s.id }, select: { tagId: true } }),
        ]);
        const newTags = tags.map((t) => t.tagId).filter((t) => !targetTags.has(t));
        newTags.forEach((t) => targetTags.add(t));
        steps.push({
          sourceId: s.id,
          changes: p.changes,
          moved: { emailIds: emails.map((e) => e.id), primaryEmailId: emails.find((e) => e.isPrimary)?.id ?? null, threadIds: threads.map((t) => t.id), leadIds: leads.map((l) => l.id), taskIds: tasks.map((t) => t.id), tagIds: newTags },
        });
      }
      const sum = (k: 'emailIds' | 'threadIds' | 'leadIds' | 'taskIds' | 'tagIds') => steps.reduce((n, st) => n + st.moved[k].length, 0);
      return { steps, fills, conflicts, moves: { emails: sum('emailIds'), threads: sum('threadIds'), leads: sum('leadIds'), tasks: sum('taskIds'), tags: sum('tagIds') } };
    };

    const preview = (b: Awaited<ReturnType<typeof build>>, mergeIds?: string[]): MergePreview => ({
      target: item(target),
      sources: (sources as Row[]).map(item),
      moves: b.moves,
      fills: b.fills,
      conflicts: b.conflicts,
      ...(mergeIds ? { mergeIds } : {}),
    });

    if (input.dryRun) return preview(await build(this.prisma));

    const result = await this.prisma.$transaction(
      async (tx) => {
        // Lock every row involved so concurrent edits or merges cannot interleave.
        await tx.$queryRaw(Prisma.sql`SELECT id FROM contacts WHERE id IN (${Prisma.join([targetId, ...sourceIds])}) ORDER BY id FOR UPDATE`);
        const stillLive = await tx.contact.count({ where: { id: { in: [targetId, ...sourceIds] }, mergedIntoId: null } });
        if (stillLive !== sourceIds.length + 1) throw Errors.conflict('One of the contacts was merged meanwhile', 'ALREADY_MERGED');
        const b = await build(tx);
        const ids: string[] = [];
        for (const st of b.steps) {
          const m = st.moved;
          await tx.contactEmail.updateMany({ where: { id: { in: m.emailIds } }, data: { contactId: targetId, isPrimary: false } });
          await tx.emailThread.updateMany({ where: { id: { in: m.threadIds } }, data: { contactId: targetId } });
          await tx.lead.updateMany({ where: { id: { in: m.leadIds } }, data: { contactId: targetId } });
          await tx.task.updateMany({ where: { id: { in: m.taskIds } }, data: { contactId: targetId } });
          await tx.contactTag.createMany({ data: m.tagIds.map((tagId) => ({ contactId: targetId, tagId })), skipDuplicates: true });
          if (Object.keys(st.changes).length) await tx.contact.update({ where: { id: targetId }, data: Object.fromEntries(Object.entries(st.changes).map(([k, v]) => [k, v!.after])) as Prisma.ContactUncheckedUpdateInput });
          await tx.contact.update({ where: { id: st.sourceId }, data: { mergedIntoId: targetId } });
          const mid = newId();
          await tx.contactMerge.create({ data: { id: mid, targetId, sourceId: st.sourceId, moved: m as unknown as Prisma.InputJsonValue, changes: st.changes as unknown as Prisma.InputJsonValue, mergedById: ctx.userId } });
          ids.push(mid);
        }
        await this.link.recomputeLastContacted(tx, [targetId]);
        await this.audit.record(tx, ctx, { action: 'contact.merge', entityType: 'Contact', entityId: targetId, after: { sourceContactIds: sourceIds, moves: b.moves }, metadata: { mergeIds: ids } });
        return { b, ids };
      },
      { timeout: 30_000 },
    );
    return preview(result.b, result.ids);
  }

  /**
   * Undoes one merge: the rows that moved go back to the source (those still on the target),
   * the source reappears, and filled-in fields are restored unless someone has changed them since.
   */
  async undoMerge(ctx: RequestContext, mergeId: string) {
    const m = await this.prisma.contactMerge.findUnique({ where: { id: mergeId } });
    if (!m) throw Errors.notFound('Merge');
    if (m.undoneAt) throw Errors.conflict('This merge was already undone', 'ALREADY_UNDONE');
    await this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw(Prisma.sql`SELECT id FROM contacts WHERE id IN (${m.targetId}, ${m.sourceId}) ORDER BY id FOR UPDATE`);
        const target = await tx.contact.findUniqueOrThrow({ where: { id: m.targetId } });
        if (target.mergedIntoId) throw Errors.conflict('The contact was merged again later; undo that merge first', 'TARGET_MERGED');
        const fresh = await tx.contactMerge.findUniqueOrThrow({ where: { id: mergeId } });
        if (fresh.undoneAt) throw Errors.conflict('This merge was already undone', 'ALREADY_UNDONE');
        const moved = m.moved as unknown as Moved;
        const changes = m.changes as unknown as Changes;
        const back = { contactId: m.sourceId };
        await tx.contactEmail.updateMany({ where: { id: { in: moved.emailIds }, contactId: m.targetId }, data: back });
        if (moved.primaryEmailId) await tx.contactEmail.updateMany({ where: { id: moved.primaryEmailId, contactId: m.sourceId }, data: { isPrimary: true } });
        // The target keeps a primary address.
        if (!(await tx.contactEmail.count({ where: { contactId: m.targetId, isPrimary: true } }))) {
          const first = await tx.contactEmail.findFirst({ where: { contactId: m.targetId }, orderBy: { email: 'asc' } });
          if (first) await tx.contactEmail.update({ where: { id: first.id }, data: { isPrimary: true } });
        }
        await tx.emailThread.updateMany({ where: { id: { in: moved.threadIds }, contactId: m.targetId }, data: back });
        await tx.lead.updateMany({ where: { id: { in: moved.leadIds }, contactId: m.targetId }, data: back });
        await tx.task.updateMany({ where: { id: { in: moved.taskIds }, contactId: m.targetId }, data: back });
        await tx.contactTag.deleteMany({ where: { contactId: m.targetId, tagId: { in: moved.tagIds } } });
        const restore: Record<string, string | null> = {};
        for (const [f, v] of Object.entries(changes) as [MergeField, { before: string | null; after: string | null }][]) {
          if ((target[f] as string | null) === v.after) restore[f] = f === 'type' ? (v.before ?? 'OTHER') : v.before;
        }
        if (Object.keys(restore).length) await tx.contact.update({ where: { id: m.targetId }, data: restore as Prisma.ContactUncheckedUpdateInput });
        await tx.contact.update({ where: { id: m.sourceId }, data: { mergedIntoId: null } });
        await tx.contactMerge.update({ where: { id: mergeId }, data: { undoneAt: new Date(), undoneById: ctx.userId } });
        await this.link.recomputeLastContacted(tx, [m.targetId, m.sourceId]);
        await this.audit.record(tx, ctx, { action: 'contact.merge.undo', entityType: 'Contact', entityId: m.targetId, metadata: { mergeId, sourceId: m.sourceId, restored: Object.keys(restore) } });
      },
      { timeout: 30_000 },
    );
    return { targetId: m.targetId, sourceId: m.sourceId };
  }
}
