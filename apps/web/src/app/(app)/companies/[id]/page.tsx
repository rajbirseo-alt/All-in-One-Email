'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import type { CompanyView, ContactListItem, LeadListItem } from '@crm/shared';
import { api } from '@/lib/api';
import { useLoad } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { CONTACT_TYPE_LABEL, LEAD_STATUS_LABEL, LEAD_TONE, money } from '@/lib/crm';
import { shortDate } from '@/lib/mail';
import { Badge, Button, Card, ErrorBanner, PageHeader, Table, Td } from '@/components/ui';
import { CompanyForm } from '@/components/crm/company-form';

type CompanyPage = CompanyView & { contacts: ContactListItem[]; leads: LeadListItem[] };

export default function CompanyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const c = useLoad(() => api<CompanyPage>(`/companies/${id}`), [id]);
  const [editing, setEditing] = useState(false);
  const d = c.data;
  if (!d) return c.error ? <ErrorBanner error={c.error} /> : null;
  return (
    <>
      <p className="mb-2 text-[13px]">
        <Link href="/companies" className="text-text-3 hover:text-text">
          ← Companies
        </Link>
      </p>
      <PageHeader
        title={d.name}
        description={[d.domain, d.country].filter(Boolean).join(' · ')}
        actions={can('contact.write') && <Button onClick={() => setEditing(true)}>Edit</Button>}
      />
      <div className="flex flex-col gap-4">
        <Card>
          <h2 className="px-4 pt-3 text-[13px] font-semibold tracking-wide text-text-3 uppercase">People ({d.contacts.length})</h2>
          <Table head={['Name', 'Email', 'Type', 'Last email']}>
            {d.contacts.map((p) => (
              <tr key={p.id}>
                <Td>
                  <Link href={`/contacts/${p.id}`} className="font-medium hover:underline">
                    {p.name ?? p.primaryEmail}
                  </Link>
                </Td>
                <Td className="text-text-2">{p.primaryEmail}</Td>
                <Td>{CONTACT_TYPE_LABEL[p.type]}</Td>
                <Td className="text-text-2">{p.lastContactedAt ? shortDate(p.lastContactedAt) : '—'}</Td>
              </tr>
            ))}
          </Table>
        </Card>
        {can('lead.read') && (
          <Card className="p-4">
            <h2 className="mb-2 text-[13px] font-semibold tracking-wide text-text-3 uppercase">Leads</h2>
            {!d.leads.length ? (
              <p className="text-[13px] text-text-3">No leads you can see.</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {d.leads.map((l) => (
                  <li key={l.id} className="flex flex-wrap items-center gap-2">
                    <Link href={`/leads?lead=${l.id}`} className="hover:underline">
                      {l.title}
                    </Link>
                    <Badge tone={LEAD_TONE[l.status]}>{LEAD_STATUS_LABEL[l.status]}</Badge>
                    <span className="text-[12.5px] text-text-3">{[money(l.estimatedValue, l.currency), l.owner?.name].filter(Boolean).join(' · ')}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </div>
      {editing && <CompanyForm company={d} onClose={() => setEditing(false)} onSaved={() => (setEditing(false), void c.reload())} />}
    </>
  );
}
