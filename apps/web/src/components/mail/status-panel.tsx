'use client';

import { useState } from 'react';
import type { StatusHistoryEntry, ThreadDetail } from '@crm/shared';
import { api, ApiError } from '@/lib/api';
import { useLoad } from '@/lib/hooks';
import { shortDate, slaBadge, STATUS_LABEL } from '@/lib/mail';
import { Badge, Button, ErrorBanner, Input, Select } from '@/components/ui';

/** What an employee can choose; NEW / ASSIGNED follow the assignment ("Reopen" picks the right one). */
const CHOICES = ['IN_PROGRESS', 'WAITING_FOR_CLIENT', 'PENDING_REPLY', 'FOLLOW_UP_REQUIRED', 'REPLY_NOT_NEEDED', 'CLOSED'];
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
const SOURCE: Record<string, string> = { USER: '', SYSTEM: 'automatically', INBOUND_MESSAGE: 'client wrote', OUTBOUND_MESSAGE: 'reply sent', AUTOMATION: 'automation', SLA: 'SLA' };
const STEP: Record<string, string> = { NOTIFY_ASSIGNEE: 'Assignee told', REMIND_ASSIGNEE: 'Reminder', ALERT_MANAGER: 'Manager alerted', ESCALATE: 'Escalated to MD' };

/** A datetime-local value (local time, minutes) for a Date. */
const local = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

export function StatusPanel({ thread, onChanged }: { thread: ThreadDetail; onChanged: () => void }) {
  const [error, setError] = useState<ApiError | null>(null);
  const [followUp, setFollowUp] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const history = useLoad(() => (showHistory ? api<StatusHistoryEntry[]>(`/threads/${thread.id}/status-history`) : Promise.resolve([])), [thread.id, showHistory, thread.status]);
  const closed = thread.status === 'CLOSED' || thread.status === 'REPLY_NOT_NEEDED';

  const run = async (path: string, body: unknown) => {
    setError(null);
    try {
      await api(`/threads/${thread.id}/${path}`, { method: 'POST', body });
      onChanged();
    } catch (e) {
      setError(e as ApiError);
    }
  };
  const due = slaBadge(thread.sla.dueAt);
  const tz = thread.sla.timezone ?? undefined;
  const at = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz });

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-3 text-[13.5px]" aria-label="Status and SLA">
      <ErrorBanner error={error} />
      <div>
        <h3 className="mb-1 text-[12px] font-semibold tracking-wide text-text-3 uppercase">Status</h3>
        {thread.canChangeStatus ? (
          <div className="flex flex-wrap gap-2">
            <Select aria-label="Status" value={thread.status} className="h-8 flex-1 text-[13px]" onChange={(e) => void run('status', { status: e.target.value })}>
              {!CHOICES.includes(thread.status) && <option value={thread.status}>{STATUS_LABEL[thread.status]}</option>}
              {CHOICES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </Select>
            {(closed || thread.status === 'WAITING_FOR_CLIENT' || thread.status === 'FOLLOW_UP_REQUIRED') && (
              <Button size="sm" onClick={() => void run('status', { status: 'OPEN' })}>
                Reopen
              </Button>
            )}
          </div>
        ) : (
          <p>{STATUS_LABEL[thread.status]}</p>
        )}
      </div>

      <div>
        <h3 className="mb-1 text-[12px] font-semibold tracking-wide text-text-3 uppercase">Priority</h3>
        {thread.canChangeStatus ? (
          <Select aria-label="Priority" value={thread.priority} className="h-8 text-[13px]" onChange={(e) => void run('priority', { priority: e.target.value })}>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p.charAt(0) + p.slice(1).toLowerCase()}
              </option>
            ))}
          </Select>
        ) : (
          <p>{thread.priority.charAt(0) + thread.priority.slice(1).toLowerCase()}</p>
        )}
      </div>

      {thread.canChangeStatus && !closed && (
        <div>
          <h3 className="mb-1 text-[12px] font-semibold tracking-wide text-text-3 uppercase">Follow up</h3>
          {thread.followUpAt ? (
            <p className="flex flex-wrap items-center gap-2">
              {new Date(thread.followUpAt).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
              <button className="text-[12px] text-text-3 underline" onClick={() => void run('status', { status: thread.status === 'FOLLOW_UP_REQUIRED' ? 'IN_PROGRESS' : thread.status, followUpAt: null })}>
                Clear
              </button>
            </p>
          ) : (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!followUp) return;
                // Waiting for the client until then; the conversation comes back as "Follow-up" at that time.
                void run('status', { status: 'WAITING_FOR_CLIENT', followUpAt: new Date(followUp).toISOString() }).then(() => setFollowUp(''));
              }}
            >
              <Input type="datetime-local" aria-label="Follow-up date" className="h-8 min-w-0 flex-1 text-[13px]" min={local(new Date())} value={followUp} onChange={(e) => setFollowUp(e.target.value)} />
              <Button size="sm" type="submit" disabled={!followUp}>
                Set
              </Button>
            </form>
          )}
        </div>
      )}

      <div>
        <h3 className="mb-1 text-[12px] font-semibold tracking-wide text-text-3 uppercase">Reply deadline</h3>
        {!thread.sla.policy ? (
          <p className="text-text-3">{thread.awaitingReplySince && !closed ? 'No SLA policy applies.' : 'No reply owed.'}</p>
        ) : (
          <>
            <p className="flex flex-wrap items-center gap-2">
              {thread.sla.dueAt ? at(thread.sla.dueAt) : '—'}
              {due && <Badge tone={due.tone}>{due.text}</Badge>}
            </p>
            <p className="text-[12px] text-text-3">
              {thread.sla.policy.name} · working hours{tz ? ` (${tz})` : ''}
            </p>
            <ol className="mt-1.5 flex flex-col gap-0.5 text-[12.5px]">
              {thread.sla.steps.map((s, i) => (
                <li key={i} className={s.firedAt ? 'text-text-2' : 'text-text-3'}>
                  {s.firedAt ? '✓' : '○'} {STEP[s.action] ?? s.action}
                  {s.marksOverdue ? ' (overdue)' : ''} · {s.dueAt ? at(s.dueAt) : 'never (no working hours)'}
                </li>
              ))}
            </ol>
          </>
        )}
      </div>

      <div>
        <button className="text-[12px] text-text-3 underline" onClick={() => setShowHistory((s) => !s)}>
          {showHistory ? 'Hide status history' : 'Status history'}
        </button>
        {showHistory && (
          <ul className="mt-1 flex flex-col gap-1 text-[12.5px] text-text-2">
            {!history.data?.length && <li>No changes yet.</li>}
            {history.data?.map((h) => (
              <li key={h.id}>
                {h.from ? `${STATUS_LABEL[h.from]} → ` : ''}
                {STATUS_LABEL[h.to]}
                {h.changedBy ? ` by ${h.changedBy.name}` : SOURCE[h.source] ? ` (${SOURCE[h.source]})` : ''} · {shortDate(h.createdAt)}
                {h.reason && h.source === 'USER' && h.reason !== 'assignment' ? ` — “${h.reason}”` : ''}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
