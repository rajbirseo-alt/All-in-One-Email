'use client';

import { useState } from 'react';
import type { CompanyView } from '@crm/shared';
import { api, ApiError } from '@/lib/api';
import { Button, ErrorBanner, Field, Input, Modal } from '@/components/ui';

export function CompanyForm({ company, onClose, onSaved }: { company?: CompanyView; onClose: () => void; onSaved: (id: string) => void }) {
  const [f, setF] = useState({ name: company?.name ?? '', domain: company?.domain ?? '', website: company?.website ?? '', country: company?.country ?? '' });
  const [error, setError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);
  const fe = error?.fieldErrors() ?? {};
  const save = async () => {
    setPending(true);
    setError(null);
    try {
      const r = await api<CompanyView>(company ? `/companies/${company.id}` : '/companies', { method: company ? 'PUT' : 'POST', body: f });
      onSaved(r.id);
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
      title={company ? 'Edit company' : 'New company'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" pending={pending} disabled={!f.name.trim()} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error && !Object.keys(fe).length && <ErrorBanner error={error} />}
        <Field label="Name" htmlFor="co-name" error={fe.name}>
          <Input id="co-name" value={f.name} maxLength={200} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label="Email domain" htmlFor="co-domain" error={fe.domain} hint="New senders from this domain join the company automatically.">
          <Input id="co-domain" value={f.domain} placeholder="example.com" onChange={(e) => setF({ ...f, domain: e.target.value })} />
        </Field>
        <Field label="Website" htmlFor="co-web" error={fe.website}>
          <Input id="co-web" value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} />
        </Field>
        <Field label="Country" htmlFor="co-country" error={fe.country}>
          <Input id="co-country" value={f.country} maxLength={80} onChange={(e) => setF({ ...f, country: e.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}
