'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { ContactDetail, ContactListItem } from '@crm/shared';
import { api, ApiError } from '@/lib/api';
import { useLoad } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { CONTACT_TYPE_LABEL } from '@/lib/crm';
import { shortDate } from '@/lib/mail';
import { Badge, Button, Card, Empty, ErrorBanner, Field, Input, Modal, PageHeader, Select, Table, Td } from '@/components/ui';
import { CompanyPicker } from '@/components/crm/pickers';

const LIMIT = 50;

export default function ContactsPage() {
  const { can } = useSession();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [type, setType] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => (setDq(q), setPage(1)), 250);
    return () => clearTimeout(t);
  }, [q]);
  const list = useLoad(() => api<{ items: ContactListItem[]; total: number }>('/contacts', { query: { q: dq, type, page, limit: LIMIT } }), [dq, type, page]);
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / LIMIT));

  return (
    <>
      <PageHeader
        title="Contacts"
        description="Everyone the company emails with. New senders are added automatically."
        actions={
          <>
            {can('contact.merge') && (
              <Button onClick={() => router.push('/contacts/duplicates')}>Find duplicates</Button>
            )}
            {can('contact.write') && (
              <Button variant="primary" onClick={() => setCreating(true)}>
                New contact
              </Button>
            )}
          </>
        }
      />
      <div className="mb-3 flex flex-wrap gap-2">
        <Input aria-label="Search contacts" placeholder="Search name, email, company or phone" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-sm" />
        <Select aria-label="Type" value={type} onChange={(e) => (setType(e.target.value), setPage(1))} className="w-40">
          <option value="">All types</option>
          {Object.entries(CONTACT_TYPE_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
      </div>
      <ErrorBanner error={list.error} />
      <Card>
        {list.data && !list.data.items.length ? (
          <Empty title={dq || type ? 'No contacts match' : 'No contacts yet'}>{!dq && !type && 'Contacts appear here as email arrives in connected mailboxes.'}</Empty>
        ) : (
          <Table head={['Name', 'Company', 'Type', 'Owner', 'Last email']}>
            {list.data?.items.map((c) => (
              <tr key={c.id} className="cursor-pointer hover:bg-surface-2" onClick={() => router.push(`/contacts/${c.id}`)}>
                <Td>
                  <Link href={`/contacts/${c.id}`} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>
                    {c.name ?? c.primaryEmail}
                  </Link>
                  <p className="text-[12.5px] text-text-3">
                    {c.name ? c.primaryEmail : ''}
                    {c.emailCount > 1 ? ` +${c.emailCount - 1}` : ''}
                  </p>
                  {c.tags.length > 0 && (
                    <span className="mt-0.5 flex flex-wrap gap-1">
                      {c.tags.map((t) => (
                        <span key={t.id} className="rounded px-1.5 text-[11.5px] text-white" style={{ background: t.color }}>
                          {t.name}
                        </span>
                      ))}
                    </span>
                  )}
                </Td>
                <Td className="text-text-2">{c.company?.name ?? '—'}</Td>
                <Td>
                  <Badge tone={c.type === 'CLIENT' ? 'success' : c.type === 'PROSPECT' ? 'accent' : 'neutral'}>{CONTACT_TYPE_LABEL[c.type]}</Badge>
                </Td>
                <Td className="text-text-2">{c.owner?.name ?? '—'}</Td>
                <Td className="whitespace-nowrap text-text-2">{c.lastContactedAt ? shortDate(c.lastContactedAt) : '—'}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {pages > 1 && (
        <div className="mt-3 flex items-center gap-2 text-[13px] text-text-2">
          <Button size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Previous
          </Button>
          Page {page} of {pages} · {list.data?.total} contacts
          <Button size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>
            Next
          </Button>
        </div>
      )}
      {creating && <NewContact onClose={() => setCreating(false)} onCreated={(id) => router.push(`/contacts/${id}`)} />}
    </>
  );
}

function NewContact({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [f, setF] = useState({ name: '', emails: '', phone: '', type: 'PROSPECT', country: '' });
  const [company, setCompany] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);
  const fe = error?.fieldErrors() ?? {};
  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      const emails = f.emails.split(/[\s,;]+/).filter(Boolean);
      const c = await api<ContactDetail>('/contacts', { method: 'POST', body: { name: f.name, emails, phone: f.phone, type: f.type, country: f.country, companyId: company?.id ?? null } });
      onCreated(c.id);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setPending(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title="New contact"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" pending={pending} onClick={() => void submit()} disabled={!f.emails.trim()}>
            Create
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error && !Object.keys(fe).length && <ErrorBanner error={error} />}
        <Field label="Name" htmlFor="c-name" error={fe.name}>
          <Input id="c-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={200} />
        </Field>
        <Field label="Email addresses" htmlFor="c-emails" hint="Separate several with commas. The first is the main one." error={fe.emails ?? Object.entries(fe).find(([k]) => k.startsWith('emails.'))?.[1]}>
          <Input id="c-emails" value={f.emails} onChange={(e) => setF({ ...f, emails: e.target.value })} />
        </Field>
        <Field label="Company" htmlFor="c-company">
          <CompanyPicker id="c-company" value={company} onChange={setCompany} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Phone" htmlFor="c-phone" error={fe.phone}>
            <Input id="c-phone" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
          </Field>
          <Field label="Type" htmlFor="c-type">
            <Select id="c-type" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
              {Object.entries(CONTACT_TYPE_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Country" htmlFor="c-country">
          <Input id="c-country" value={f.country} onChange={(e) => setF({ ...f, country: e.target.value })} maxLength={80} />
        </Field>
        <p className="text-[12.5px] text-text-3">You will own this contact; you can hand it over on its page.</p>
      </div>
    </Modal>
  );
}
