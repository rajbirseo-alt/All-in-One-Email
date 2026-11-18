'use client';

import { useState } from 'react';
import type { AssigneeOptions, AssignmentEntry, NoteView, Page, TagView, ThreadDetail, UserSummary } from '@crm/shared';
import { api, ApiError } from '@/lib/api';
import { useLoad } from '@/lib/hooks';
import { shortDate } from '@/lib/mail';
import { useSession } from '@/lib/session';
import { Badge, Button, ErrorBanner, Select } from '@/components/ui';

const METHOD: Record<string, string> = { MANUAL: 'manually', BULK: 'in bulk', RULE: 'by rule', ROUND_ROBIN: 'round-robin', LEAST_LOADED: 'least-loaded' };

/** Renders @[userId] mentions as @Name (text only; notes are never HTML). */
function noteText(n: NoteView) {
  return n.body.replace(/@\[([A-Za-z0-9-]+)\]/g, (_, id: string) => `@${n.mentions.find((m) => m.id === id)?.name ?? 'someone'}`);
}

export function CollabPanel({ thread, onChanged }: { thread: ThreadDetail; onChanged: () => void }) {
  const { can, me } = useSession();
  const [error, setError] = useState<ApiError | null>(null);
  const [note, setNote] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const options = useLoad(() => (thread.canAssign ? api<AssigneeOptions>(`/threads/${thread.id}/assignees`) : Promise.resolve(null)), [thread.id, thread.canAssign]);
  const tags = useLoad(() => api<TagView[]>('/tags'), []);
  const notes = useLoad(() => api<NoteView[]>(`/threads/${thread.id}/notes`), [thread.id, thread.version]);
  const people = useLoad(() => (can('user.read') ? api<Page<UserSummary>>('/users', { query: { limit: 100, status: 'ACTIVE' } }) : Promise.resolve(null)), []);
  const history = useLoad(() => (showHistory ? api<AssignmentEntry[]>(`/threads/${thread.id}/assignments`) : Promise.resolve([])), [thread.id, showHistory, thread.assignee?.id]);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError(e as ApiError);
    }
  };

  const assign = (value: string) => {
    if (!value) return;
    if (value === 'none') return run(() => api(`/threads/${thread.id}/unassign`, { method: 'POST' }));
    const [kind, id] = value.split(':');
    const body = kind === 'u' ? { assigneeId: id } : kind === 't' ? { teamId: id } : { departmentId: id };
    return run(() => api(`/threads/${thread.id}/assign`, { method: 'POST', body }));
  };

  const addNote = () =>
    run(async () => {
      await api(`/threads/${thread.id}/notes`, { method: 'POST', body: { body: note } });
      setNote('');
      await notes.reload();
    });

  const current = thread.assignee ? `u:${thread.assignee.id}` : thread.team ? `t:${thread.team.id}` : thread.department ? `d:${thread.department.id}` : '';
  const users = people.data?.items ?? [];

  return (
    <aside className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-3 text-[13.5px]" aria-label="Team">
      <ErrorBanner error={error} />
      <section>
        <h3 className="mb-1 text-[12px] font-semibold tracking-wide text-text-3 uppercase">Assigned to</h3>
        {thread.canAssign && options.data ? (
          <Select aria-label="Assign" value={current} onChange={(e) => void assign(e.target.value)} className="h-8 text-[13px]">
            <option value="">{current ? '' : 'Unassigned'}</option>
            {current && <option value="none">— Unassign —</option>}
            {options.data.users.length > 0 && (
              <optgroup label="People">
                {options.data.users.map((u) => (
                  <option key={u.id} value={`u:${u.id}`}>
                    {u.name}
                    {u.isAbsent ? ' (away)' : ''}
                  </option>
                ))}
              </optgroup>
            )}
            {options.data.teams.length > 0 && (
              <optgroup label="Team queues">
                {options.data.teams.map((t) => (
                  <option key={t.id} value={`t:${t.id}`}>
                    {t.name}
                  </option>
                ))}
              </optgroup>
            )}
            {options.data.departments.length > 0 && (
              <optgroup label="Department queues">
                {options.data.departments.map((d) => (
                  <option key={d.id} value={`d:${d.id}`}>
                    {d.name}
                  </option>
                ))}
              </optgroup>
            )}
          </Select>
        ) : (
          <p>{thread.assignee?.name ?? thread.team?.name ?? thread.department?.name ?? 'Unassigned'}</p>
        )}
        {(thread.team || thread.department) && thread.assignee && (
          <p className="mt-1 text-[12px] text-text-3">
            Queue: {thread.team?.name ?? ''}
            {thread.team && thread.department ? ' · ' : ''}
            {thread.department?.name ?? ''}
          </p>
        )}
        <button className="mt-1 text-[12px] text-text-3 underline" onClick={() => setShowHistory((s) => !s)}>
          {showHistory ? 'Hide history' : 'History'}
        </button>
        {showHistory && (
          <ul className="mt-1 flex flex-col gap-1 text-[12.5px] text-text-2">
            {!history.data?.length && <li>No assignments yet.</li>}
            {history.data?.map((h) => (
              <li key={h.id}>
                {h.assignee?.name ?? h.team?.name ?? h.department?.name} · {METHOD[h.method] ?? h.method.toLowerCase()}
                {h.rule ? ` (${h.rule.name})` : ''}
                {h.assignedBy ? ` by ${h.assignedBy.name}` : ''} · {shortDate(h.createdAt)}
                {h.reason && h.method === 'MANUAL' ? ` — “${h.reason}”` : ''}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="mb-1 text-[12px] font-semibold tracking-wide text-text-3 uppercase">Tags</h3>
        <div className="flex flex-wrap items-center gap-1">
          {thread.tags.map((t) => (
            <span key={t.id} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[12px] font-medium text-white" style={{ background: t.color }}>
              {t.name}
              <button aria-label={`Remove ${t.name}`} onClick={() => void run(() => api(`/threads/${thread.id}/tags/${t.id}`, { method: 'DELETE' }))}>
                ✕
              </button>
            </span>
          ))}
          {!!tags.data?.filter((t) => !thread.tags.some((x) => x.id === t.id)).length && (
            <Select aria-label="Add tag" value="" className="h-7 w-28 text-[12px]" onChange={(e) => e.target.value && void run(() => api(`/threads/${thread.id}/tags/${e.target.value}`, { method: 'PUT' }))}>
              <option value="">+ Tag</option>
              {tags.data!
                .filter((t) => !thread.tags.some((x) => x.id === t.id))
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </Select>
          )}
        </div>
      </section>

      {(thread.canShare || thread.shares.length > 0) && (
        <section>
          <h3 className="mb-1 text-[12px] font-semibold tracking-wide text-text-3 uppercase">Shared with</h3>
          <ul className="flex flex-col gap-1">
            {thread.shares.map((s) => (
              <li key={s.user.id} className="flex items-center justify-between gap-2">
                <span>
                  {s.user.name} {s.canReply && <Badge>can reply</Badge>}
                </span>
                {thread.canShare && (
                  <button className="text-[12px] text-text-3 hover:text-danger" onClick={() => void run(() => api(`/threads/${thread.id}/shares/${s.user.id}`, { method: 'DELETE' }))}>
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
          {thread.canShare && users.length > 0 && (
            <Select aria-label="Share with" value="" className="mt-1 h-7 text-[12px]" onChange={(e) => e.target.value && void run(() => api(`/threads/${thread.id}/shares/${e.target.value}`, { method: 'PUT', body: { canReply: false } }))}>
              <option value="">Share with…</option>
              {users
                .filter((u) => u.id !== me.user.id && !thread.shares.some((s) => s.user.id === u.id))
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
            </Select>
          )}
        </section>
      )}

      <section>
        <h3 className="mb-1 text-[12px] font-semibold tracking-wide text-text-3 uppercase">Internal notes</h3>
        <p className="mb-2 text-[12px] text-text-3">Only colleagues see these. They are never sent to the client.</p>
        <ul className="mb-2 flex flex-col gap-2">
          {notes.data?.map((n) => (
            <li key={n.id} className="rounded-md bg-warning-soft px-2.5 py-2">
              <p className="text-[12px] text-text-3">
                {n.author.name} · {shortDate(n.createdAt)}
                {n.editedAt ? ' · edited' : ''}
                {n.canEdit && (
                  <button className="ml-2 underline" onClick={() => confirm('Delete this note?') && void run(async () => (await api(`/threads/${thread.id}/notes/${n.id}`, { method: 'DELETE' }), await notes.reload()))}>
                    delete
                  </button>
                )}
              </p>
              <p className="whitespace-pre-wrap">{noteText(n)}</p>
            </li>
          ))}
        </ul>
        <textarea
          aria-label="New note"
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Write a note for your team…"
          className="w-full rounded-md border border-border bg-surface p-2 text-[13.5px]"
        />
        <div className="mt-1 flex items-center gap-2">
          <Button size="sm" variant="primary" disabled={!note.trim()} onClick={() => void addNote()}>
            Add note
          </Button>
          {users.length > 0 && (
            <Select aria-label="Mention" value="" className="h-7 w-32 text-[12px]" onChange={(e) => e.target.value && setNote((v) => `${v}${v && !v.endsWith(' ') ? ' ' : ''}@[${e.target.value}] `)}>
              <option value="">@ Mention…</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
          )}
        </div>
        <p className="mt-1 text-[11.5px] text-text-3">Mentioning someone lets them see this conversation.</p>
      </section>
    </aside>
  );
}
