'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { CompanyView } from '@crm/shared';
import { api } from '@/lib/api';
import { useLoad } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { Button, Card, Empty, ErrorBanner, Input, PageHeader, Table, Td } from '@/components/ui';
import { CompanyForm } from '@/components/crm/company-form';

export default function CompaniesPage() {
  const { can } = useSession();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setDq(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const list = useLoad(() => api<CompanyView[]>('/companies', { query: { q: dq, limit: 100 } }), [dq]);
  return (
    <>
      <PageHeader
        title="Companies"
        description="Grouped by email domain. Free email providers such as gmail.com never form a company."
        actions={
          can('contact.write') && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              New company
            </Button>
          )
        }
      />
      <Input aria-label="Search companies" placeholder="Search by name or domain" value={q} onChange={(e) => setQ(e.target.value)} className="mb-3 max-w-sm" />
      <ErrorBanner error={list.error} />
      <Card>
        {list.data && !list.data.length ? (
          <Empty title={dq ? 'No companies match' : 'No companies yet'} />
        ) : (
          <Table head={['Company', 'Domain', 'Contacts', 'Open leads']}>
            {list.data?.map((c) => (
              <tr key={c.id} className="cursor-pointer hover:bg-surface-2" onClick={() => router.push(`/companies/${c.id}`)}>
                <Td>
                  <Link href={`/companies/${c.id}`} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>
                    {c.name}
                  </Link>
                </Td>
                <Td className="text-text-2">{c.domain ?? '—'}</Td>
                <Td>{c.contactCount}</Td>
                <Td>{c.openLeadCount}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {list.data?.length === 100 && <p className="mt-2 text-[12.5px] text-text-3">Showing the first 100. Search to narrow down.</p>}
      {creating && <CompanyForm onClose={() => setCreating(false)} onSaved={(id) => router.push(`/companies/${id}`)} />}
    </>
  );
}
