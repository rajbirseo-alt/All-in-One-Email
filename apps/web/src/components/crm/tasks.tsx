'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { PersonRef, TaskView } from '@crm/shared';
import { api, ApiError } from '@/lib/api';
import { useLoad } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { dueText, localInput } from '@/lib/crm';
import { Badge, Button, ErrorBanner, Input, Select } from '@/components/ui';

/** A compact task list with a done checkbox; links appear only when the API says the viewer may open them. */
export function TaskList({ tasks, onChanged, showLinks = true, highlight }: { tasks: TaskView[]; onChanged: () => void; showLinks?: boolean; highlight?: string | null }) {
  const [error, setError] = useState<ApiError | null>(null);
  const { me } = useSession();
  const toggle = async (t: TaskView) => {
    setError(null);
    try {
      await api(`/tasks/${t.id}/${t.status === 'DONE' ? 'reopen' : 'complete'}`, { method: 'POST' });
      onChanged();
    } catch (e) {
      setError(e as ApiError);
    }
  };
  if (!tasks.length) return <p className="text-[13px] text-text-3">No tasks.</p>;
  const now = Date.now();
  return (
    <div className="flex flex-col gap-1">
      <ErrorBanner error={error} />
      <ul className="flex flex-col divide-y divide-border">
        {tasks.map((t) => {
          const overdue = t.status === 'OPEN' && t.dueAt && new Date(t.dueAt).getTime() < now;
          return (
            <li key={t.id} id={`task-${t.id}`} className={`flex items-start gap-2.5 py-2 ${highlight === t.id ? 'rounded bg-accent-soft px-2' : ''}`}>
              <input
                type="checkbox"
                className="mt-1"
                aria-label={t.status === 'DONE' ? `Reopen ${t.title}` : `Mark ${t.title} done`}
                checked={t.status === 'DONE'}
                disabled={!t.canEdit || t.status === 'CANCELLED'}
                onChange={() => void toggle(t)}
              />
              <div className="min-w-0 flex-1">
                <p className={t.status === 'OPEN' ? '' : 'text-text-3 line-through'}>{t.title}</p>
                <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px] text-text-3">
                  {t.dueAt && <span className={overdue ? 'font-medium text-danger' : ''}>{overdue ? 'Overdue · ' : 'Due '}{dueText(t.dueAt)}</span>}
                  {t.assignee.id !== me.user.id && <span>for {t.assignee.name}</span>}
                  {t.status === 'CANCELLED' && <Badge>cancelled</Badge>}
                  {showLinks && t.thread && (
                    <Link className="underline hover:text-text" href={`/inbox?thread=${t.thread.id}`}>
                      {t.thread.subject}
                    </Link>
                  )}
                  {showLinks && t.lead && (
                    <Link className="underline hover:text-text" href={`/leads?lead=${t.lead.id}`}>
                      Lead: {t.lead.title}
                    </Link>
                  )}
                  {showLinks && t.contact && !t.lead && (
                    <Link className="underline hover:text-text" href={`/contacts/${t.contact.id}`}>
                      {t.contact.name ?? 'Contact'}
                    </Link>
                  )}
                </p>
                {t.description && <p className="mt-0.5 text-[12.5px] whitespace-pre-wrap text-text-2">{t.description}</p>}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Inline "add a task" form; the assignee list is whoever the caller may give tasks to. */
export function AddTask({ link, onAdded, compact }: { link: { threadId?: string; leadId?: string; contactId?: string }; onAdded: () => void; compact?: boolean }) {
  const { me } = useSession();
  const [open, setOpen] = useState(!compact);
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [assigneeId, setAssigneeId] = useState(me.user.id);
  const [error, setError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);
  const people = useLoad(() => (open ? api<PersonRef[]>('/tasks/assignee-options') : Promise.resolve([])), [open]);
  if (!open)
    return (
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        + Add task
      </Button>
    );
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!title.trim()) return;
        setPending(true);
        setError(null);
        try {
          await api('/tasks', { method: 'POST', body: { title, dueAt: due ? new Date(due).toISOString() : null, assigneeId, ...link } });
          setTitle('');
          setDue('');
          onAdded();
          if (compact) setOpen(false);
        } catch (err) {
          setError(err as ApiError);
        } finally {
          setPending(false);
        }
      }}
    >
      <ErrorBanner error={error} />
      <Input aria-label="Task" placeholder="What needs doing?" value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} className="h-8 text-[13px]" />
      <div className="flex flex-wrap gap-2">
        <Input type="datetime-local" aria-label="Due" className="h-8 min-w-0 flex-1 text-[13px]" min={localInput(new Date())} value={due} onChange={(e) => setDue(e.target.value)} />
        {(people.data?.length ?? 0) > 1 && (
          <Select aria-label="Assign to" className="h-8 min-w-0 flex-1 text-[13px]" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
            {people.data!.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id === me.user.id ? `${p.name} (me)` : p.name}
              </option>
            ))}
          </Select>
        )}
        <Button size="sm" type="submit" variant="primary" pending={pending} disabled={!title.trim()}>
          Add
        </Button>
        {compact && (
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
