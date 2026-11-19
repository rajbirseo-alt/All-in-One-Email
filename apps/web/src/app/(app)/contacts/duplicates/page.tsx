'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { ContactListItem, DuplicatePair, MergePreview } from '@crm/shared';
import { api, ApiError } from '@/lib/api';
import { useLoad } from '@/lib/hooks';
import { CONTACT_TYPE_LABEL } from '@/lib/crm';
import { shortDate } from '@/lib/mail';
import { Badge, Button, Card, Empty, ErrorBanner, Modal, PageHeader } from '@/components/ui';
import { MergePreviewView } from '@/components/crm/merge-preview';

function Side({ c }: { c: ContactListItem }) {
  return (
    <div className="min-w-0">
      <Link href={`/contacts/${c.id}`} className="font-medium hover:underline">
        {c.name ?? c.primaryEmail}
      </Link>
      <p className="truncate text-[12.5px] text-text-3">
        {[c.primaryEmail, c.emailCount > 1 ? `+${c.emailCount - 1}` : null].filter(Boolean).join(' ')}
      </p>
      <p className="text-[12.5px] text-text-3">{[c.company?.name, c.phone, CONTACT_TYPE_LABEL[c.type], c.lastContactedAt ? `last email ${shortDate(c.lastContactedAt)}` : null].filter(Boolean).join(' · ')}</p>
    </div>
  );
}

export default function DuplicatesPage() {
  const pairs = useLoad(() => api<DuplicatePair[]>('/contacts/duplicates'), []);
  const [error, setError] = useState<ApiError | null>(null);
  const [merge, setMerge] = useState<{ keep: ContactListItem; drop: ContactListItem; preview: MergePreview | null } | null>(null);
  const [pending, setPending] = useState(false);

  const start = async (keep: ContactListItem, drop: ContactListItem) => {
    setError(null);
    setMerge({ keep, drop, preview: null });
    try {
      const preview = await api<MergePreview>(`/contacts/${keep.id}/merge`, { method: 'POST', body: { sourceContactIds: [drop.id], dryRun: true } });
      setMerge({ keep, drop, preview });
    } catch (e) {
      setMerge(null);
      setError(e as ApiError);
    }
  };
  const commit = async () => {
    if (!merge) return;
    setPending(true);
    try {
      await api(`/contacts/${merge.keep.id}/merge`, { method: 'POST', body: { sourceContactIds: [merge.drop.id] } });
      setMerge(null);
      await pairs.reload();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setPending(false);
    }
  };
  const dismiss = async (p: DuplicatePair) => {
    setError(null);
    try {
      await api('/contacts/duplicates/dismiss', { method: 'POST', body: { aId: p.a.id, bId: p.b.id } });
      await pairs.reload();
    } catch (e) {
      setError(e as ApiError);
    }
  };

  return (
    <>
      <p className="mb-2 text-[13px]">
        <Link href="/contacts" className="text-text-3 hover:text-text">
          ← Contacts
        </Link>
      </p>
      <PageHeader title="Possible duplicates" description="Contacts that look like the same person: same phone number, similar name at the same company, or the same name." />
      <ErrorBanner error={error ?? pairs.error} />
      {pairs.data && !pairs.data.length ? (
        <Card>
          <Empty title="No likely duplicates">Pairs you mark as different people stay hidden.</Empty>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {pairs.data?.map((p) => (
            <Card key={`${p.a.id}-${p.b.id}`} className="p-4">
              <div className="mb-2 flex flex-wrap gap-1.5">
                {p.reasons.map((r) => (
                  <Badge key={r} tone="warning">
                    {r}
                  </Badge>
                ))}
                <span className="text-[12.5px] text-text-3">match {Math.round(p.score * 100)}%</span>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Side c={p.a} />
                <Side c={p.b} />
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" onClick={() => void start(p.a, p.b)}>
                  Keep {p.a.name ?? p.a.primaryEmail}
                </Button>
                <Button size="sm" onClick={() => void start(p.b, p.a)}>
                  Keep {p.b.name ?? p.b.primaryEmail}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void dismiss(p)}>
                  Not the same person
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
      {merge && (
        <Modal
          open
          wide
          onClose={() => setMerge(null)}
          title="Merge contacts"
          footer={
            <>
              <Button onClick={() => setMerge(null)}>Cancel</Button>
              <Button variant="primary" disabled={!merge.preview} pending={pending} onClick={() => void commit()}>
                Merge
              </Button>
            </>
          }
        >
          {merge.preview ? <MergePreviewView preview={merge.preview} /> : <p className="text-text-3">Working out what changes…</p>}
        </Modal>
      )}
    </>
  );
}
