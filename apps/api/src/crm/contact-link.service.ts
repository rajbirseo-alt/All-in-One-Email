import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@crm/db';
import { newId } from '@crm/crypto';
import { companyNameFromDomain, emailDomain, isAutomatedAddress, isFreeMailDomain, type Participant } from '@crm/shared';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PrismaService, type Tx } from '../prisma/prisma.service';

interface Party {
  address: string;
  name: string | null;
}

const people = (v: Prisma.JsonValue): Participant[] => (Array.isArray(v) ? (v as unknown as Participant[]) : []);

/** "'Jane Doe'" / "jane@acme.com" → a usable display name, or null. */
function cleanName(name: string | null | undefined, address: string): string | null {
  const n = (name ?? '').replace(/^["'\s]+|["'\s]+$/g, '').trim();
  return n && n.toLowerCase() !== address ? n.slice(0, 200) : null;
}

/**
 * Matches every conversation to the outside person it is with, creating the contact (and the
 * company, by email domain) the first time an address is seen. Runs after each sync and send.
 *
 * - The outside party is the sender of the first incoming message. When that sender is one of
 *   ours or a robot (a website form, "noreply@"), the Reply-To address is used instead, so
 *   enquiries from web forms land on the real client. For conversations we started, it is the
 *   first outside recipient.
 * - Our own mailboxes, employees and company domains never become contacts. Robots are never
 *   created automatically (an existing contact is still matched).
 * - Free-mail domains (gmail.com, …) never create a company.
 * - A conversation keeps the contact it already has; one address always maps to one contact.
 */
@Injectable()
export class ContactLinkService {
  private readonly log = new Logger(ContactLinkService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  private async internalSet(addresses: string[]): Promise<Set<string>> {
    const list = [...new Set(addresses)];
    if (!list.length) return new Set();
    const [accounts, users] = await Promise.all([
      this.prisma.emailAccount.findMany({ where: { emailAddress: { in: list, mode: 'insensitive' } }, select: { emailAddress: true } }),
      this.prisma.user.findMany({ where: { email: { in: list, mode: 'insensitive' } }, select: { email: true } }),
    ]);
    const out = new Set([...accounts.map((a) => a.emailAddress.toLowerCase()), ...users.map((u) => u.email.toLowerCase())]);
    const companyDomains = new Set(this.cfg.ALLOWED_LOGIN_DOMAINS.map((d) => d.toLowerCase()));
    for (const a of list) if (companyDomains.has(emailDomain(a))) out.add(a);
    return out;
  }

  /** The person outside the company this conversation is with. */
  async externalParty(threadId: string): Promise<Party | null> {
    const msgs = await this.prisma.emailMessage.findMany({
      where: { threadId },
      orderBy: { receivedAt: 'asc' },
      take: 5,
      select: { direction: true, fromAddress: true, fromName: true, replyTo: true, toRecipients: true, ccRecipients: true },
    });
    if (!msgs.length) return null;
    const all = msgs.flatMap((m) => [m.fromAddress, ...people(m.replyTo).map((p) => p.address), ...people(m.toRecipients).map((p) => p.address), ...people(m.ccRecipients).map((p) => p.address)]);
    const internal = await this.internalSet(all.map((a) => a.toLowerCase()).filter(Boolean));
    const outside = (p: { address: string; name?: string | null }) => {
      const a = p.address?.trim().toLowerCase();
      return a && a.includes('@') && !internal.has(a) ? { address: a, name: cleanName(p.name, a) } : null;
    };
    const firstIn = msgs.find((m) => m.direction === 'INBOUND');
    if (firstIn) {
      const from = outside({ address: firstIn.fromAddress, name: firstIn.fromName });
      const replyTo = people(firstIn.replyTo).map(outside).find((p): p is Party => !!p && !isAutomatedAddress(p.address));
      if (replyTo && (!from || isAutomatedAddress(from.address))) return replyTo;
      if (from) return from;
      if (replyTo) return replyTo;
    }
    for (const m of msgs.filter((x) => x.direction === 'OUTBOUND')) {
      const to = [...people(m.toRecipients), ...people(m.ccRecipients)].map(outside).find((p): p is Party => !!p);
      if (to) return to;
    }
    return null;
  }

  /** The company for a domain (created on first sight); null for free mail. */
  async companyFor(db: Tx, domain: string): Promise<string | null> {
    if (!domain || isFreeMailDomain(domain)) return null;
    const existing = await db.company.findUnique({ where: { domain }, select: { id: true } });
    if (existing) return existing.id;
    try {
      return (await db.company.create({ data: { id: newId(), name: companyNameFromDomain(domain), domain, website: domain }, select: { id: true } })).id;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return (await db.company.findUnique({ where: { domain }, select: { id: true } }))?.id ?? null;
      throw e;
    }
  }

  /** The live contact for an address, creating it unless the address is a robot. */
  async contactFor(party: Party, departmentId: string | null): Promise<string | null> {
    const found = await this.prisma.contactEmail.findUnique({ where: { email: party.address }, select: { contact: { select: { id: true, mergedIntoId: true } } } });
    if (found) return this.live(found.contact.id);
    if (isAutomatedAddress(party.address)) return null;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const companyId = await this.companyFor(tx, emailDomain(party.address));
        const id = newId();
        await tx.contact.create({ data: { id, name: party.name, companyId, departmentId, type: 'OTHER' } });
        await tx.contactEmail.create({ data: { id: newId(), contactId: id, email: party.address, isPrimary: true } });
        return id;
      });
    } catch (e) {
      // Another sync created the same address at the same moment: use that contact.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const again = await this.prisma.contactEmail.findUnique({ where: { email: party.address }, select: { contactId: true } });
        return again ? this.live(again.contactId) : null;
      }
      throw e;
    }
  }

  /** Follows merge pointers to the contact that is still shown. */
  async live(contactId: string): Promise<string> {
    let id = contactId;
    for (let i = 0; i < 20; i++) {
      const c = await this.prisma.contact.findUnique({ where: { id }, select: { mergedIntoId: true } });
      if (!c?.mergedIntoId) return id;
      id = c.mergedIntoId;
    }
    return id;
  }

  /** Links conversations without a contact and moves each contact's "last communication" forward. */
  async linkThreads(threadIds: Iterable<string>) {
    const ids = [...threadIds];
    if (!ids.length) return;
    const threads = await this.prisma.emailThread.findMany({
      where: { id: { in: ids } },
      select: { id: true, contactId: true, lastMessageAt: true, departmentId: true, emailAccount: { select: { departmentId: true } } },
    });
    const touched = new Map<string, Date>();
    for (const t of threads) {
      let contactId = t.contactId;
      if (!contactId) {
        try {
          const party = await this.externalParty(t.id);
          contactId = party ? await this.contactFor(party, t.departmentId ?? t.emailAccount.departmentId) : null;
          if (contactId) await this.prisma.emailThread.updateMany({ where: { id: t.id, contactId: null }, data: { contactId } });
        } catch (e) {
          this.log.error(`Contact matching for ${t.id} failed: ${(e as Error).message}`);
        }
      }
      if (contactId && (!touched.has(contactId) || touched.get(contactId)! < t.lastMessageAt)) touched.set(contactId, t.lastMessageAt);
    }
    for (const [id, at] of touched) {
      await this.prisma.contact.updateMany({ where: { id, OR: [{ lastContactedAt: null }, { lastContactedAt: { lt: at } }] }, data: { lastContactedAt: at } });
    }
  }

  /** Recomputes "last communication" from the contact's conversations (after a merge or undo). */
  async recomputeLastContacted(db: Tx, contactIds: string[]) {
    for (const id of contactIds) {
      const last = await db.emailThread.aggregate({ where: { contactId: id }, _max: { lastMessageAt: true } });
      await db.contact.update({ where: { id }, data: { lastContactedAt: last._max.lastMessageAt ?? null } });
    }
  }
}
