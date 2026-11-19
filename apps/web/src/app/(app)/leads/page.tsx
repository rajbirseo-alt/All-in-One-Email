'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import type { ContactListItem, LeadDetail, LeadListItem, LeadSummary, PersonRef } from '@crm/shared';
import { api, ApiError } from '@/lib/api';
import { useLoad } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { LEAD_STATUS_LABEL, LEAD_STATUS_ORDER, LEAD_TONE, money } from '@/lib/crm';
import { shortDate } from '@/lib/mail';
import { Badge, Button, Card, ErrorBanner, Field, Input, Modal, PageHeader, Select, formatDate } from '@/components/ui';
import { ContactPicker } from '@/components/crm/pickers';
import { AddTask, TaskList } from '@/components/crm/tasks';

export default function LeadsPage() {
  return (
    <Suspense>
      <Leads />
    </Suspense>
  );
}

function Leads() {
  const { can } = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const open = params.get('lead');
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setDq(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const leads = useLoad(() => api<LeadListItem[]>('/leads', { query: { q: dq, ownerId } }), [dq, ownerId]);
  const summary = useLoad(() => api<LeadSummary>('/leads/summary'), []);
  const reload = () => (void leads.reload(), void summary.reload());
  const owners = new Map<string, PersonRef>();
  for (const l of leads.data ?? []) if (l.owner) owners.set(l.owner.id, l.owner);
  const s = summary.data;

  return (
    <>
      <PageHeader
        title="Leads"
        description="Sales enquiries from first email to won or lost."
        actions={
          can('lead.write') && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              New lead
            </Button>
          )
        }
      />
      {s && (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Open" value={String(s.open)} />
          <Stat label="Won" value={String(s.won)} />
          <Stat label="Lost" value={String(s.lost)} />
          <Stat label="Conversion" value={s.conversionRate === null ? '—' : `${Math.round(s.conversionRate * 100)}%`} hint={s.wonValue.map((w) => money(w.value, w.currency)).join(' + ') || undefined} />
        </div>
      )}
      <div className="mb-3 flex flex-wrap gap-2">
        <Input aria-label="Search leads" placeholder="Search title, contact or company" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-sm" />
        {owners.size > 1 || ownerId ? (
          <Select aria-label="Owner" value={ownerId} onChange={(e) => setOwnerId(e.target.value)} className="w-48">
            <option value="">Everyone</option>
            {[...owners.values()].map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
        ) : null}
      </div>
      <ErrorBanner error={leads.error} />
      <div className="flex gap-3 overflow-x-auto pb-3">
        {LEAD_STATUS_ORDER.map((status) => {
          const col = (leads.data ?? []).filter((l) => l.status === status);
          return (
            <section key={status} className="flex w-64 shrink-0 flex-col gap-2 rounded-lg bg-surface-2 p-2" aria-label={LEAD_STATUS_LABEL[status]}>
              <h2 className="flex items-center justify-between px-1 text-[13px] font-semibold">
                {LEAD_STATUS_LABEL[status]} <span className="font-normal text-text-3">{col.length}</span>
              </h2>
              {col.map((l) => (
                <button key={l.id} onClick={() => router.push(`/leads?lead=${l.id}`)} className="rounded-md border border-border bg-surface p-2.5 text-left hover:border-accent">
                  <p className="line-clamp-2 font-medium">{l.title}</p>
                  <p className="truncate text-[12.5px] text-text-2">{[l.contact.name ?? l.contact.email, l.company?.name].filter(Boolean).join(' · ')}</p>
                  <p className="mt-1 flex flex-wrap gap-x-2 text-[12px] text-text-3">
                    {money(l.estimatedValue, l.currency) && <span>{money(l.estimatedValue, l.currency)}</span>}
                    <span>{l.owner?.name ?? 'No owner'}</span>
                    {l.openTasks > 0 && <span>{l.openTasks} task{l.openTasks > 1 ? 's' : ''}</span>}
                  </p>
                </button>
              ))}
            </section>
          );
        })}
      </div>
      {s && s.byOwner.length > 1 && (
        <Card className="mt-2 p-4">
          <h2 className="mb-2 text-[13px] font-semibold tracking-wide text-text-3 uppercase">By owner</h2>
          <table className="w-full text-[13.5px]">
            <thead className="text-left text-[12px] text-text-3">
              <tr>
                <th className="py-1 font-medium">Owner</th>
                <th className="font-medium">Open</th>
                <th className="font-medium">Won</th>
                <th className="font-medium">Lost</th>
                <th className="font-medium">Conversion</th>
              </tr>
            </thead>
            <tbody>
              {s.byOwner.map((o) => (
                <tr key={o.owner?.id ?? 'none'} className="border-t border-border">
                  <td className="py-1.5">{o.owner?.name ?? 'No owner'}</td>
                  <td>{o.open}</td>
                  <td>{o.won}</td>
                  <td>{o.lost}</td>
                  <td>{o.won + o.lost ? `${Math.round((o.won / (o.won + o.lost)) * 100)}%` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {open && <LeadModal id={open} onClose={() => router.push('/leads')} onChanged={reload} />}
      {creating && <NewLead onClose={() => setCreating(false)} onCreated={(id) => (setCreating(false), reload(), router.push(`/leads?lead=${id}`))} />}
    </>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="px-4 py-3">
      <p className="text-[12px] font-medium text-text-3 uppercase">{label}</p>
      <p className="text-[22px] font-semibold tabular-nums">{value}</p>
      {hint && <p className="truncate text-[12px] text-text-3">{hint} won</p>}
    </Card>
  );
}

function LeadModal({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const lead = useLoad(() => api<LeadDetail>(`/leads/${id}`), [id]);
  const owners = useLoad(() => (lead.data?.canEdit ? api<PersonRef[]>('/leads/owner-options') : Promise.resolve([] as PersonRef[])), [lead.data?.canEdit]);
  const [error, setError] = useState<ApiError | null>(null);
  const [next, setNext] = useState('');
  const [note, setNote] = useState('');
  const [edit, setEdit] = useState<{ title: string; estimatedValue: string; currency: string; serviceInterest: string } | null>(null);
  const l = lead.data;

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await lead.reload();
      onChanged();
      return true;
    } catch (e) {
      setError(e as ApiError);
      return false;
    }
  };
  const fe = error?.fieldErrors() ?? {};
  const ownerChoices = [...(owners.data ?? [])];
  if (l?.owner && !ownerChoices.some((o) => o.id === l.owner!.id)) ownerChoices.unshift(l.owner);

  return (
    <Modal open wide onClose={onClose} title={l?.title ?? 'Lead'}>
      {!l ? (
        lead.error ? <ErrorBanner error={lead.error} /> : <p className="text-text-3">Loading…</p>
      ) : (
        <div className="flex flex-col gap-4 text-[13.5px]">
          {error && !Object.keys(fe).length && <ErrorBanner error={error} />}
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={LEAD_TONE[l.status]}>{LEAD_STATUS_LABEL[l.status]}</Badge>
            <span className="text-text-2">
              <Link href={`/contacts/${l.contact.id}`} className="hover:underline">
                {l.contact.name ?? l.contact.email}
              </Link>
              {l.company && (
                <>
                  {' · '}
                  <Link href={`/companies/${l.company.id}`} className="hover:underline">
                    {l.company.name}
                  </Link>
                </>
              )}
            </span>
            {l.sourceThread && (
              <Link href={`/inbox?thread=${l.sourceThread.id}`} className="text-text-3 underline hover:text-text">
                Open the email
              </Link>
            )}
          </div>
          {l.status === 'LOST' && l.lostReason && <p className="text-danger">Lost: {l.lostReason}</p>}

          {edit ? (
            <form
              className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-2"
              onSubmit={(e) => {
                e.preventDefault();
                void run(() => api(`/leads/${l.id}`, { method: 'PUT', body: { title: edit.title, estimatedValue: edit.estimatedValue === '' ? null : edit.estimatedValue, currency: edit.currency, serviceInterest: edit.serviceInterest } })).then((ok) => ok && setEdit(null));
              }}
            >
              <div className="sm:col-span-2">
                <Field label="Title" htmlFor="l-title" error={fe.title}>
                  <Input id="l-title" value={edit.title} maxLength={300} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
                </Field>
              </div>
              <Field label="Estimated value" htmlFor="l-value" error={fe.estimatedValue}>
                <Input id="l-value" type="number" min={0} step="0.01" value={edit.estimatedValue} onChange={(e) => setEdit({ ...edit, estimatedValue: e.target.value })} />
              </Field>
              <Field label="Currency" htmlFor="l-cur" error={fe.currency}>
                <Input id="l-cur" value={edit.currency} maxLength={3} onChange={(e) => setEdit({ ...edit, currency: e.target.value.toUpperCase() })} />
              </Field>
              <div className="sm:col-span-2">
                <Field label="Service interest" htmlFor="l-svc" error={fe.serviceInterest}>
                  <Input id="l-svc" value={edit.serviceInterest} maxLength={80} placeholder="e.g. SEO, PPC, Web development" onChange={(e) => setEdit({ ...edit, serviceInterest: e.target.value })} />
                </Field>
              </div>
              <div className="flex gap-2 sm:col-span-2">
                <Button size="sm" variant="primary" type="submit">
                  Save
                </Button>
                <Button size="sm" onClick={() => setEdit(null)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <dl className="grid grid-cols-[130px_minmax(0,1fr)] gap-x-3 gap-y-1.5">
              <dt className="text-text-3">Value</dt>
              <dd>{money(l.estimatedValue, l.currency) ?? '—'}</dd>
              <dt className="text-text-3">Service</dt>
              <dd>{l.serviceInterest ?? '—'}</dd>
              <dt className="text-text-3">Owner</dt>
              <dd>
                {l.canEdit && ownerChoices.length > 0 ? (
                  <Select aria-label="Owner" className="h-8 max-w-xs text-[13px]" value={l.owner?.id ?? ''} onChange={(e) => void run(() => api(`/leads/${l.id}`, { method: 'PUT', body: { ownerId: e.target.value || null } }))}>
                    <option value="">No owner</option>
                    {ownerChoices.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </Select>
                ) : (
                  (l.owner?.name ?? 'No owner')
                )}
                {fe.ownerId && <p className="text-[12.5px] text-danger">{fe.ownerId}</p>}
              </dd>
              <dt className="text-text-3">Department</dt>
              <dd>{l.department?.name ?? '—'}</dd>
              <dt className="text-text-3">Source</dt>
              <dd>{l.source === 'INBOUND_EMAIL' ? 'Incoming email' : 'Added by hand'}</dd>
              <dt className="text-text-3">Created</dt>
              <dd>{formatDate(l.createdAt)}</dd>
              {l.canEdit && (
                <dd className="col-span-2">
                  <Button size="sm" variant="ghost" onClick={() => setEdit({ title: l.title, estimatedValue: l.estimatedValue ?? '', currency: l.currency ?? 'USD', serviceInterest: l.serviceInterest ?? '' })}>
                    Edit details
                  </Button>
                </dd>
              )}
            </dl>
          )}

          {l.canEdit && (
            <form
              className="flex flex-col gap-2 rounded-md border border-border p-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (!next) return;
                void run(() => api(`/leads/${l.id}/status`, { method: 'POST', body: next === 'LOST' ? { status: next, lostReason: note } : { status: next, note } })).then((ok) => ok && (setNext(''), setNote('')));
              }}
            >
              <p className="font-medium">Move to</p>
              <div className="flex flex-wrap gap-2">
                <Select aria-label="New stage" value={next} onChange={(e) => setNext(e.target.value)} className="h-8 w-48 text-[13px]">
                  <option value="">Choose a stage</option>
                  {LEAD_STATUS_ORDER.filter((s) => s !== l.status).map((s) => (
                    <option key={s} value={s}>
                      {LEAD_STATUS_LABEL[s]}
                    </option>
                  ))}
                </Select>
                <Input aria-label={next === 'LOST' ? 'Why was it lost?' : 'Note'} placeholder={next === 'LOST' ? 'Why was it lost? (required)' : 'Note (optional)'} value={note} maxLength={next === 'LOST' ? 500 : 1000} onChange={(e) => setNote(e.target.value)} className="h-8 min-w-0 flex-1 text-[13px]" />
                <Button size="sm" variant="primary" type="submit" disabled={!next || (next === 'LOST' && !note.trim())}>
                  Move
                </Button>
              </div>
              {fe.lostReason && <p className="text-[12.5px] text-danger">{fe.lostReason}</p>}
            </form>
          )}

          <div>
            <h3 className="mb-1 text-[12px] font-semibold tracking-wide text-text-3 uppercase">Tasks</h3>
            <TaskList tasks={l.tasks} onChanged={() => void lead.reload()} showLinks={false} />
            <div className="mt-1">
              <AddTask compact link={{ leadId: l.id }} onAdded={() => (void lead.reload(), onChanged())} />
            </div>
          </div>

          <div>
            <h3 className="mb-1 text-[12px] font-semibold tracking-wide text-text-3 uppercase">History</h3>
            <ul className="flex flex-col gap-1 text-[13px] text-text-2">
              {l.history.map((h) => (
                <li key={h.id}>
                  {h.from ? `${LEAD_STATUS_LABEL[h.from]} → ` : 'Opened as '}
                  {LEAD_STATUS_LABEL[h.to]}
                  {h.changedBy ? ` by ${h.changedBy.name}` : ' (automatically)'} · {shortDate(h.createdAt)}
                  {h.note ? ` — “${h.note}”` : ''}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </Modal>
  );
}

function NewLead({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [contact, setContact] = useState<ContactListItem | null>(null);
  const [f, setF] = useState({ title: '', estimatedValue: '', currency: 'USD', serviceInterest: '' });
  const [error, setError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);
  const fe = error?.fieldErrors() ?? {};
  const submit = async () => {
    if (!contact) return;
    setPending(true);
    setError(null);
    try {
      const l = await api<LeadDetail>('/leads', {
        method: 'POST',
        body: { contactId: contact.id, title: f.title || undefined, estimatedValue: f.estimatedValue === '' ? null : f.estimatedValue, currency: f.currency, serviceInterest: f.serviceInterest },
      });
      onCreated(l.id);
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
      title="New lead"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!contact} pending={pending} onClick={() => void submit()}>
            Create
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error && !Object.keys(fe).length && <ErrorBanner error={error} />}
        <p className="text-[12.5px] text-text-3">To make a lead from an email, use “Create lead” next to the conversation in the inbox.</p>
        <Field label="Contact" htmlFor="nl-contact">
          <ContactPicker id="nl-contact" value={contact} onChange={setContact} />
        </Field>
        <Field label="Title" htmlFor="nl-title" hint="Leave empty for “Enquiry from …”." error={fe.title}>
          <Input id="nl-title" value={f.title} maxLength={300} onChange={(e) => setF({ ...f, title: e.target.value })} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Estimated value" htmlFor="nl-value" error={fe.estimatedValue}>
            <Input id="nl-value" type="number" min={0} step="0.01" value={f.estimatedValue} onChange={(e) => setF({ ...f, estimatedValue: e.target.value })} />
          </Field>
          <Field label="Currency" htmlFor="nl-cur" error={fe.currency}>
            <Input id="nl-cur" value={f.currency} maxLength={3} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} />
          </Field>
        </div>
        <Field label="Service interest" htmlFor="nl-svc">
          <Input id="nl-svc" value={f.serviceInterest} maxLength={80} placeholder="e.g. SEO, PPC, Web development" onChange={(e) => setF({ ...f, serviceInterest: e.target.value })} />
        </Field>
        <p className="text-[12.5px] text-text-3">You will own the lead and get a follow-up task due in 24 hours.</p>
      </div>
    </Modal>
  );
}
