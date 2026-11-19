'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { ContactDetail, ContactListItem, ContactTimeline, LeadDetail, MergePreview, PersonRef, TagView } from '@crm/shared';
import { api, ApiError } from '@/lib/api';
import { useLoad } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { CONTACT_TYPE_LABEL, LEAD_STATUS_LABEL, LEAD_TONE, money } from '@/lib/crm';
import { shortDate, STATUS_LABEL } from '@/lib/mail';
import { Badge, Button, Card, ErrorBanner, Field, Input, Modal, PageHeader, Select, formatDate } from '@/components/ui';
import { CompanyPicker, ContactPicker } from '@/components/crm/pickers';
import { AddTask, TaskList } from '@/components/crm/tasks';
import { MergePreviewView } from '@/components/crm/merge-preview';

const h2 = 'mb-2 text-[13px] font-semibold tracking-wide text-text-3 uppercase';

export default function ContactPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { can } = useSession();
  const c = useLoad(() => api<ContactDetail>(`/contacts/${id}`), [id]);
  const tl = useLoad(() => api<ContactTimeline>(`/contacts/${id}/timeline`), [id]);
  const [error, setError] = useState<ApiError | null>(null);
  const [editing, setEditing] = useState(false);
  const [merging, setMerging] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const d = c.data;

  // A merged contact's address opens the contact it was merged into.
  useEffect(() => {
    if (d && d.id !== id) router.replace(`/contacts/${d.id}`);
  }, [d, id, router]);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await Promise.all([c.reload(), tl.reload()]);
    } catch (e) {
      setError(e as ApiError);
    }
  };

  if (!d) return c.error ? <ErrorBanner error={c.error} /> : null;
  return (
    <>
      <p className="mb-2 text-[13px]">
        <Link href="/contacts" className="text-text-3 hover:text-text">
          ← Contacts
        </Link>
      </p>
      <PageHeader
        title={d.name ?? d.primaryEmail ?? 'Contact'}
        description={[d.company?.name, CONTACT_TYPE_LABEL[d.type], d.owner ? `Owner: ${d.owner.name}` : null].filter(Boolean).join(' · ')}
        actions={
          <>
            {can('lead.write') && (
              <Button
                onClick={() =>
                  void run(async () => {
                    const lead = await api<LeadDetail>('/leads', { method: 'POST', body: { contactId: d.id } });
                    router.push(`/leads?lead=${lead.id}`);
                  })
                }
              >
                Create lead
              </Button>
            )}
            {d.canMerge && <Button onClick={() => setMerging(true)}>Merge another contact in</Button>}
            {d.canEdit && (
              <Button variant="primary" onClick={() => setEditing(true)}>
                Edit
              </Button>
            )}
          </>
        }
      />
      <ErrorBanner error={error} />
      <div className="mt-3 grid gap-4 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          <Card className="p-4">
            <h2 className={h2}>Email addresses</h2>
            <ul className="flex flex-col gap-1.5">
              {d.emails.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center gap-2">
                  <a href={`mailto:${e.email}`} className="min-w-0 truncate hover:underline">
                    {e.email}
                  </a>
                  {e.isPrimary ? (
                    <Badge tone="accent">main</Badge>
                  ) : (
                    d.canEdit && (
                      <>
                        <button className="text-[12px] text-text-3 underline" onClick={() => void run(() => api(`/contacts/${d.id}/emails/${e.id}/primary`, { method: 'POST' }))}>
                          Make main
                        </button>
                        <button className="text-[12px] text-danger underline" onClick={() => void run(() => api(`/contacts/${d.id}/emails/${e.id}`, { method: 'DELETE' }))}>
                          Remove
                        </button>
                      </>
                    )
                  )}
                </li>
              ))}
            </ul>
            {d.canEdit && (
              <form
                className="mt-2 flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (newEmail.trim()) void run(() => api(`/contacts/${d.id}/emails`, { method: 'POST', body: { email: newEmail } })).then(() => setNewEmail(''));
                }}
              >
                <Input aria-label="Add email address" placeholder="Add another address" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} className="h-8 text-[13px]" />
                <Button size="sm" type="submit" disabled={!newEmail.trim()}>
                  Add
                </Button>
              </form>
            )}
          </Card>

          <Card className="p-4">
            <h2 className={h2}>Details</h2>
            <dl className="grid grid-cols-[100px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13.5px]">
              <dt className="text-text-3">Phone</dt>
              <dd>{d.phone ? <a href={`tel:${d.phone}`}>{d.phone}</a> : '—'}</dd>
              <dt className="text-text-3">Company</dt>
              <dd>{d.company ? <Link href={`/companies/${d.company.id}`} className="hover:underline">{d.company.name}</Link> : '—'}</dd>
              <dt className="text-text-3">Website</dt>
              <dd className="truncate">{d.website ? <a href={/^https?:/.test(d.website) ? d.website : `https://${d.website}`} target="_blank" rel="noopener noreferrer nofollow" className="hover:underline">{d.website}</a> : '—'}</dd>
              <dt className="text-text-3">Country</dt>
              <dd>{d.country ?? '—'}</dd>
              <dt className="text-text-3">Department</dt>
              <dd>{d.department?.name ?? '—'}</dd>
              <dt className="text-text-3">Last email</dt>
              <dd>{d.lastContactedAt ? formatDate(d.lastContactedAt) : '—'}</dd>
              <dt className="text-text-3">Added</dt>
              <dd>{formatDate(d.createdAt)}</dd>
            </dl>
            {d.notes && (
              <>
                <h3 className="mt-3 mb-1 text-[12px] font-semibold text-text-3 uppercase">Internal notes</h3>
                <p className="text-[13.5px] whitespace-pre-wrap">{d.notes}</p>
              </>
            )}
          </Card>

          <TagsCard contact={d} onChanged={() => void c.reload()} />

          {d.canMerge && d.merges.length > 0 && (
            <Card className="p-4">
              <h2 className={h2}>Merged into this contact</h2>
              <ul className="flex flex-col gap-2 text-[13px]">
                {d.merges.map((m) => (
                  <li key={m.id}>
                    <p>
                      {m.source.name ?? m.source.emails[0] ?? 'A contact'} {m.source.emails.length > 0 && <span className="text-text-3">({m.source.emails.join(', ')})</span>}
                    </p>
                    <p className="text-[12.5px] text-text-3">
                      {shortDate(m.createdAt)}
                      {m.mergedBy ? ` by ${m.mergedBy.name}` : ''} · {m.moved.threads} conversations, {m.moved.leads} leads, {m.moved.tasks} tasks
                    </p>
                    {m.undoneAt ? (
                      <p className="text-[12.5px] text-text-3">Undone {shortDate(m.undoneAt)}</p>
                    ) : (
                      <Button size="sm" className="mt-1" onClick={() => void run(() => api(`/contact-merges/${m.id}/undo`, { method: 'POST' }))}>
                        Undo merge
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        <div className="flex flex-col gap-4">
          <Card className="p-4">
            <h2 className={h2}>Conversations</h2>
            {!tl.data?.threads.length ? (
              <p className="text-[13px] text-text-3">No conversations you can see.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {tl.data.threads.map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-2">
                    <Link href={`/inbox?thread=${t.id}`} className="min-w-0 flex-1 truncate font-medium hover:underline">
                      {t.subject}
                    </Link>
                    <Badge>{STATUS_LABEL[t.status] ?? t.status}</Badge>
                    <span className="text-[12.5px] text-text-3">
                      {t.mailbox} · {t.messageCount} messages · {shortDate(t.lastMessageAt)}
                      {t.assignee ? ` · ${t.assignee.name}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {can('lead.read') && (
            <Card className="p-4">
              <h2 className={h2}>Leads</h2>
              {!tl.data?.leads.length ? (
                <p className="text-[13px] text-text-3">No leads.</p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {tl.data.leads.map((l) => (
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

          {can('task.read') && (
            <Card className="p-4">
              <h2 className={h2}>Tasks</h2>
              <TaskList tasks={tl.data?.tasks ?? []} onChanged={() => void tl.reload()} />
              {can('task.write') && (
                <div className="mt-2">
                  <AddTask compact link={{ contactId: d.id }} onAdded={() => void tl.reload()} />
                </div>
              )}
            </Card>
          )}
        </div>
      </div>
      {editing && <EditContact contact={d} onClose={() => setEditing(false)} onSaved={() => (setEditing(false), void c.reload())} />}
      {merging && <MergeIn target={d} onClose={() => setMerging(false)} onMerged={() => (setMerging(false), void c.reload(), void tl.reload())} />}
    </>
  );
}

function TagsCard({ contact, onChanged }: { contact: ContactDetail; onChanged: () => void }) {
  const tags = useLoad(() => (contact.canEdit ? api<TagView[]>('/tags') : Promise.resolve([] as TagView[])), [contact.canEdit]);
  const [error, setError] = useState<ApiError | null>(null);
  const on = new Set(contact.tags.map((t) => t.id));
  if (!contact.canEdit && !contact.tags.length) return null;
  const toggle = async (id: string) => {
    setError(null);
    const next = on.has(id) ? [...on].filter((x) => x !== id) : [...on, id];
    try {
      await api(`/contacts/${contact.id}/tags`, { method: 'PUT', body: { tagIds: next } });
      onChanged();
    } catch (e) {
      setError(e as ApiError);
    }
  };
  const list = contact.canEdit ? (tags.data ?? []) : contact.tags;
  return (
    <Card className="p-4">
      <h2 className={h2}>Tags</h2>
      <ErrorBanner error={error} />
      {!list.length && <p className="text-[13px] text-text-3">No tags exist yet. Administrators create them under Routing rules.</p>}
      <div className="flex flex-wrap gap-1.5">
        {list.map((t) => (
          <button
            key={t.id}
            disabled={!contact.canEdit}
            onClick={() => void toggle(t.id)}
            aria-pressed={on.has(t.id)}
            className={`rounded px-2 py-0.5 text-[12.5px] ${on.has(t.id) ? 'text-white' : 'border border-border text-text-2'}`}
            style={on.has(t.id) ? { background: t.color } : undefined}
          >
            {t.name}
          </button>
        ))}
      </div>
    </Card>
  );
}

function EditContact({ contact, onClose, onSaved }: { contact: ContactDetail; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: contact.name ?? '', phone: contact.phone ?? '', website: contact.website ?? '', country: contact.country ?? '', type: contact.type, ownerId: contact.owner?.id ?? '', notes: contact.notes ?? '' });
  const [company, setCompany] = useState(contact.company);
  const owners = useLoad(() => api<PersonRef[]>('/contacts/owner-options'), []);
  const [error, setError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);
  const fe = error?.fieldErrors() ?? {};
  const save = async () => {
    setPending(true);
    setError(null);
    try {
      await api(`/contacts/${contact.id}`, { method: 'PUT', body: { ...f, ownerId: f.ownerId || null, companyId: company?.id ?? null } });
      onSaved();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setPending(false);
    }
  };
  const ownerChoices = [...(owners.data ?? [])];
  if (contact.owner && !ownerChoices.some((o) => o.id === contact.owner!.id)) ownerChoices.unshift(contact.owner);
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title="Edit contact"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" pending={pending} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {error && !Object.keys(fe).length && (
          <div className="sm:col-span-2">
            <ErrorBanner error={error} />
          </div>
        )}
        <Field label="Name" htmlFor="e-name" error={fe.name}>
          <Input id="e-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label="Company" htmlFor="e-company">
          <CompanyPicker id="e-company" value={company} onChange={(v) => setCompany(v ? { ...v, domain: null } : null)} />
        </Field>
        <Field label="Phone" htmlFor="e-phone" error={fe.phone}>
          <Input id="e-phone" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        </Field>
        <Field label="Website" htmlFor="e-web" error={fe.website}>
          <Input id="e-web" value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} />
        </Field>
        <Field label="Country" htmlFor="e-country" error={fe.country}>
          <Input id="e-country" value={f.country} onChange={(e) => setF({ ...f, country: e.target.value })} />
        </Field>
        <Field label="Type" htmlFor="e-type">
          <Select id="e-type" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
            {Object.entries(CONTACT_TYPE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Owner" htmlFor="e-owner" error={fe.ownerId}>
          <Select id="e-owner" value={f.ownerId} onChange={(e) => setF({ ...f, ownerId: e.target.value })}>
            <option value="">Nobody</option>
            {ownerChoices.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="sm:col-span-2">
          <Field label="Internal notes" htmlFor="e-notes" hint="Only colleagues see these. They are never added to emails.">
            <textarea id="e-notes" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} rows={5} maxLength={10000} className="w-full rounded-md border border-border bg-surface px-3 py-2 text-text focus:border-accent focus:outline-none" />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

function MergeIn({ target, onClose, onMerged }: { target: ContactDetail; onClose: () => void; onMerged: () => void }) {
  const [source, setSource] = useState<ContactListItem | null>(null);
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    setPreview(null);
    if (!source) return;
    void api<MergePreview>(`/contacts/${target.id}/merge`, { method: 'POST', body: { sourceContactIds: [source.id], dryRun: true } }).then(setPreview, (e) => setError(e as ApiError));
  }, [source, target.id]);
  const commit = async () => {
    setPending(true);
    setError(null);
    try {
      await api(`/contacts/${target.id}/merge`, { method: 'POST', body: { sourceContactIds: [source!.id] } });
      onMerged();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setPending(false);
    }
  };
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={`Merge into ${target.name ?? target.primaryEmail}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!preview} pending={pending} onClick={() => void commit()}>
            Merge
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <ErrorBanner error={error} />
        <Field label="Contact to merge in" htmlFor="m-src" hint="Its addresses, conversations, leads and tasks move to this contact. It can be undone later.">
          <ContactPicker id="m-src" value={source} onChange={setSource} exclude={[target.id]} />
        </Field>
        {preview && <MergePreviewView preview={preview} />}
      </div>
    </Modal>
  );
}
