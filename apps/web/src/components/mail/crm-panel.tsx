'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { LeadDetail, ThreadCrm, ThreadDetail } from '@crm/shared';
import { api, ApiError } from '@/lib/api';
import { useLoad } from '@/lib/hooks';
import { CONTACT_TYPE_LABEL, LEAD_STATUS_LABEL, LEAD_TONE } from '@/lib/crm';
import { Badge, Button, ErrorBanner } from '@/components/ui';
import { AddTask, TaskList } from '@/components/crm/tasks';

const h3 = 'mb-1 text-[12px] font-semibold tracking-wide text-text-3 uppercase';

/** Who the conversation is with, its sales leads and its tasks. */
export function CrmPanel({ thread }: { thread: ThreadDetail }) {
  const crm = useLoad(() => api<ThreadCrm>(`/threads/${thread.id}/crm`), [thread.id, thread.version]);
  const [error, setError] = useState<ApiError | null>(null);
  const [creating, setCreating] = useState(false);
  const d = crm.data;
  if (!d) return crm.error ? <ErrorBanner error={crm.error} /> : null;
  if (!d.contact && !d.leads.length && !d.tasks.length && !d.canCreateTask) return null;

  const createLead = async () => {
    setCreating(true);
    setError(null);
    try {
      await api<LeadDetail>('/leads', { method: 'POST', body: { threadId: thread.id } });
      await crm.reload();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setCreating(false);
    }
  };

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-3 text-[13.5px]" aria-label="Contact, leads and tasks">
      <ErrorBanner error={error} />
      {d.contact && (
        <div>
          <h3 className={h3}>Contact</h3>
          <Link href={`/contacts/${d.contact.id}`} className="font-medium hover:underline">
            {d.contact.name ?? d.contact.primaryEmail}
          </Link>
          <p className="text-[12.5px] text-text-3">
            {[d.contact.company?.name, CONTACT_TYPE_LABEL[d.contact.type], d.contact.phone].filter(Boolean).join(' · ')}
          </p>
          {d.contact.emailCount > 1 && <p className="text-[12.5px] text-text-3">{d.contact.emailCount} email addresses</p>}
        </div>
      )}

      {(d.leads.length > 0 || d.canCreateLead) && (
        <div>
          <h3 className={h3}>Leads</h3>
          <ul className="flex flex-col gap-1">
            {d.leads.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center gap-2">
                <Link href={`/leads?lead=${l.id}`} className="min-w-0 truncate hover:underline">
                  {l.title}
                </Link>
                <Badge tone={LEAD_TONE[l.status]}>{LEAD_STATUS_LABEL[l.status]}</Badge>
                {l.owner && <span className="text-[12px] text-text-3">{l.owner.name}</span>}
              </li>
            ))}
          </ul>
          {d.canCreateLead && (
            <Button size="sm" className="mt-1.5" onClick={() => void createLead()} pending={creating}>
              Create lead
            </Button>
          )}
        </div>
      )}

      {(d.tasks.length > 0 || d.canCreateTask) && (
        <div>
          <h3 className={h3}>Tasks</h3>
          <TaskList tasks={d.tasks} onChanged={() => void crm.reload()} showLinks={false} />
          {d.canCreateTask && <AddTask compact link={{ threadId: thread.id }} onAdded={() => void crm.reload()} />}
        </div>
      )}
    </section>
  );
}
