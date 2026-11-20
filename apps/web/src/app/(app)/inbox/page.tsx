'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { AssigneeOptions, BulkResult, DraftView, MailboxSummary, PresenceEntry, ThreadCounts, ThreadDetail, ThreadListItem } from '@crm/shared';
import { api, ApiError } from '@/lib/api';
import { useLoad } from '@/lib/hooks';
import { formatAddresses, formatBytes, prefersDark, shortDate, slaBadge, STATUS_LABEL, STATUS_TONE, who } from '@/lib/mail';
import { useLiveEvent } from '@/lib/live';
import { useSession } from '@/lib/session';
import { Badge, Button, ErrorBanner, Input, Select } from '@/components/ui';
import { Composer } from '@/components/mail/composer';
import { MessageFrame } from '@/components/mail/message-frame';
import { CollabPanel } from '@/components/mail/collab-panel';
import { StatusPanel } from '@/components/mail/status-panel';
import { CrmPanel } from '@/components/mail/crm-panel';
import { AiPanel } from '@/components/mail/ai-panel';
import { useAiStatus } from '@/lib/ai';

const VIEWS: { key: string; label: string }[] = [
  { key: 'inbox', label: 'Inbox' },
  { key: 'mine', label: 'Assigned to me' },
  { key: 'unassigned', label: 'Unassigned' },
  { key: 'unread', label: 'Unread' },
  { key: 'pending', label: 'Awaiting reply' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'starred', label: 'Starred' },
  { key: 'snoozed', label: 'Snoozed' },
  { key: 'followup', label: 'Follow-up' },
  { key: 'waiting', label: 'Waiting for client' },
  { key: 'sent', label: 'Sent' },
  { key: 'archive', label: 'Archive' },
  { key: 'closed', label: 'Closed' },
  { key: 'spam', label: 'Spam' },
  { key: 'trash', label: 'Trash' },
  { key: 'all', label: 'All mail' },
];

function snoozeOptions() {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const nextWeek = new Date(now);
  nextWeek.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7));
  nextWeek.setHours(9, 0, 0, 0);
  return [
    { label: 'In 3 hours', at: new Date(now.getTime() + 3 * 3_600_000) },
    { label: 'Tomorrow 9:00', at: tomorrow },
    { label: 'Next Monday 9:00', at: nextWeek },
  ];
}

/** useSearchParams needs a Suspense boundary in the App Router. */
export default function InboxRoute() {
  return (
    <Suspense fallback={<p className="p-6 text-text-3">Loading…</p>}>
      <InboxPage />
    </Suspense>
  );
}

function InboxPage() {
  const { can, me } = useSession();
  const ai = useAiStatus();
  const router = useRouter();
  const params = useSearchParams();
  const linked = params.get('thread');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [bulkOptions, setBulkOptions] = useState<AssigneeOptions | null>(null);
  const [bulkNote, setBulkNote] = useState<string | null>(null);
  const [presence, setPresence] = useState<PresenceEntry[]>([]);
  const [view, setView] = useState('inbox');
  const [accountId, setAccountId] = useState('');
  const [query, setQuery] = useState('');
  const [q, setQ] = useState('');
  const [items, setItems] = useState<ThreadListItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [listError, setListError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [images, setImages] = useState(false);
  const [composer, setComposer] = useState<DraftView | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const counts = useLoad(() => api<ThreadCounts>('/threads/counts'), []);
  const mailboxes = useLoad(() => api<MailboxSummary[]>('/accounts'), []);
  const dark = useMemo(() => prefersDark(), []);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;

  const loadList = useCallback(
    async (append = false, after: string | null = null) => {
      setLoading(true);
      try {
        const page = await api<{ items: ThreadListItem[]; nextCursor: string | null }>('/threads', {
          query: { view, accountId: accountId || undefined, q: q || undefined, cursor: append ? after : undefined, limit: 50 },
        });
        setItems((prev) => (append ? [...prev, ...page.items] : page.items));
        setCursor(page.nextCursor);
        setListError(null);
      } catch (e) {
        setListError(e as ApiError);
      } finally {
        setLoading(false);
      }
    },
    [view, accountId, q],
  );

  const loadDetail = useCallback(async (id: string, withImages: boolean) => {
    try {
      setDetail(await api<ThreadDetail>(`/threads/${id}`, { query: { images: withImages ? 'true' : undefined } }));
    } catch (e) {
      setActionError(e as ApiError);
      setDetail(null);
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  // Live updates over the shared event stream: refresh the list, counts and the open conversation.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useLiveEvent('thread.updated', (data) => {
    const ids = (data as { threadIds: string[] }).threadIds ?? [];
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      void loadList();
      void counts.reload();
      if (selectedRef.current && ids.includes(selectedRef.current)) void loadDetail(selectedRef.current, false);
    }, 400);
  });
  useLiveEvent('presence', (data) => {
    const p = data as { threadId: string; users: PresenceEntry[] };
    if (p.threadId === selectedRef.current) setPresence(p.users.filter((u) => u.userId !== me.user.id));
  });
  useEffect(() => () => void (refreshTimer.current && clearTimeout(refreshTimer.current)), []);

  // Tell colleagues who is looking at / replying to the open conversation (refreshed every 30 s).
  const composing = !!composer && !!selected;
  useEffect(() => {
    if (!selected) return;
    const say = (state: string) => api(`/threads/${selected}/presence`, { method: 'POST', body: { state } }).catch(() => undefined);
    void say(composing ? 'composing' : 'viewing');
    const t = setInterval(() => void say(composing ? 'composing' : 'viewing'), 30_000);
    return () => {
      clearInterval(t);
      void say('left');
    };
  }, [selected, composing]);
  useEffect(() => setPresence(detail?.presence ?? []), [detail]);

  const toggle = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  useEffect(() => {
    setChecked(new Set());
    setBulkNote(null);
  }, [view, accountId, q]);
  useEffect(() => {
    const first = [...checked][0];
    if (!first || !can('conversation.assign')) return setBulkOptions(null);
    api<AssigneeOptions>(`/threads/${first}/assignees`).then(setBulkOptions, () => setBulkOptions(null));
  }, [checked, can]);

  const bulk = async (action: string, extra: Record<string, string> = {}) => {
    try {
      const r = await api<BulkResult>('/threads/bulk', { method: 'POST', body: { threadIds: [...checked], action, ...extra } });
      setBulkNote(r.failed.length ? `${r.done} updated, ${r.failed.length} not allowed or not found` : `${r.done} updated`);
      setChecked(new Set());
      await loadList();
      void counts.reload();
    } catch (e) {
      setBulkNote((e as ApiError).message);
    }
  };

  const open = async (id: string) => {
    setSelected(id);
    setComposer(null);
    setImages(false);
    setActionError(null);
    await loadDetail(id, false);
    const item = items.find((i) => i.id === id);
    if (item?.unreadCount) {
      await api(`/threads/${id}/read`, { method: 'POST' }).catch(() => undefined);
      setItems((prev) => prev.map((i) => (i.id === id ? { ...i, unreadCount: 0 } : i)));
      void counts.reload();
    }
  };

  // Opened from a notification (/inbox?thread=…): show that conversation, then drop the parameter.
  useEffect(() => {
    if (!linked) return;
    void open(linked);
    router.replace('/inbox');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linked]);

  const act = async (action: string) => {
    if (!detail) return;
    setActionError(null);
    try {
      await api(`/threads/${detail.id}/${action}`, { method: 'POST' });
      if (['archive', 'spam', 'unarchive', 'not-spam'].includes(action)) {
        setSelected(null);
        setDetail(null);
      } else await loadDetail(detail.id, images);
      await loadList();
      void counts.reload();
    } catch (e) {
      setActionError(e as ApiError);
    }
  };

  const snooze = async (until: Date) => {
    if (!detail) return;
    try {
      await api(`/threads/${detail.id}/snooze`, { method: 'POST', body: { until: until.toISOString() } });
      setSelected(null);
      setDetail(null);
      await loadList();
    } catch (e) {
      setActionError(e as ApiError);
    }
  };

  const startDraft = async (body: { mode: string; threadId?: string; messageId?: string; emailAccountId?: string }) => {
    setActionError(null);
    try {
      // Continue an unsent draft for this conversation instead of starting a second one.
      if (body.threadId && body.mode !== 'FORWARD') {
        const existing = (await api<DraftView[]>('/drafts', { query: { threadId: body.threadId } })).find((d) => d.status !== 'QUEUED' && d.mode === body.mode);
        if (existing) return setComposer(existing);
      }
      setComposer(await api<DraftView>('/drafts', { method: 'POST', body }));
    } catch (e) {
      setActionError(e as ApiError);
    }
  };

  const [newFrom, setNewFrom] = useState('');
  const sendable = (mailboxes.data ?? []).filter((m) => m.status !== 'DISCONNECTED');
  const search = (e: FormEvent) => {
    e.preventDefault();
    setQ(query.trim());
  };

  return (
    <div className="flex h-full">
      {/* Views */}
      <aside className="hidden w-52 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border p-2 md:flex" aria-label="Views">
        {can('conversation.reply') && sendable.length > 0 && (
          <div className="mb-2 flex flex-col gap-1">
            <Select aria-label="Send from" value={newFrom} onChange={(e) => setNewFrom(e.target.value)} className="h-8 text-[13px]">
              <option value="">New email from…</option>
              {sendable.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.emailAddress}
                </option>
              ))}
            </Select>
            <Button size="sm" variant="primary" disabled={!newFrom} onClick={() => void startDraft({ mode: 'NEW', emailAccountId: newFrom }).then(() => setSelected(null))}>
              Compose
            </Button>
          </div>
        )}
        {VIEWS.map((v) => (
          <button
            key={v.key}
            onClick={() => {
              setView(v.key);
              setSelected(null);
              setDetail(null);
            }}
            aria-current={view === v.key ? 'page' : undefined}
            className={`flex items-center justify-between rounded-md px-2.5 py-1.5 text-left text-[14px] ${view === v.key ? 'bg-accent-soft font-medium text-accent' : 'text-text-2 hover:bg-surface-2'}`}
          >
            {v.label}
            {!!counts.data?.[v.key] && <span className="text-[12px] tabular-nums">{counts.data[v.key]}</span>}
          </button>
        ))}
        {(mailboxes.data?.length ?? 0) > 1 && (
          <Select aria-label="Mailbox" value={accountId} onChange={(e) => setAccountId(e.target.value)} className="mt-3 h-8 text-[13px]">
            <option value="">All mailboxes</option>
            {mailboxes.data!.map((m) => (
              <option key={m.id} value={m.id}>
                {m.emailAddress}
              </option>
            ))}
          </Select>
        )}
      </aside>

      {/* List */}
      <section className={`flex w-full shrink-0 flex-col border-r border-border md:w-96 ${selected || composer ? 'hidden lg:flex' : 'flex'}`} aria-label="Conversations">
        <form onSubmit={search} className="flex gap-2 border-b border-border p-2">
          <Input type="search" placeholder="Search mail…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search mail" className="h-8" />
          <select aria-label="View" className="rounded-md border border-border bg-surface px-1 text-[13px] md:hidden" value={view} onChange={(e) => setView(e.target.value)}>
            {VIEWS.map((v) => (
              <option key={v.key} value={v.key}>
                {v.label}
              </option>
            ))}
          </select>
        </form>
        <ErrorBanner error={listError} />
        {checked.size > 0 && (
          <div className="flex flex-wrap items-center gap-1 border-b border-border bg-surface-2 px-2 py-1.5 text-[13px]" role="toolbar" aria-label="Bulk actions">
            <span className="mr-1 font-medium">{checked.size} selected</span>
            {bulkOptions && (
              <Select
                aria-label="Assign selected"
                value=""
                className="h-7 w-36 text-[12.5px]"
                onChange={(e) => {
                  const [k, id] = e.target.value.split(':');
                  if (id) void bulk('assign', k === 'u' ? { assigneeId: id } : k === 't' ? { teamId: id } : { departmentId: id });
                }}
              >
                <option value="">Assign to…</option>
                {bulkOptions.users.map((u) => (
                  <option key={u.id} value={`u:${u.id}`}>
                    {u.name}
                  </option>
                ))}
                {bulkOptions.teams.map((t) => (
                  <option key={t.id} value={`t:${t.id}`}>
                    Team: {t.name}
                  </option>
                ))}
                {bulkOptions.departments.map((d) => (
                  <option key={d.id} value={`d:${d.id}`}>
                    Dept: {d.name}
                  </option>
                ))}
              </Select>
            )}
            <Button size="sm" variant="ghost" onClick={() => void bulk('read')}>
              Mark read
            </Button>
            {can('conversation.status') && (
              <Button size="sm" variant="ghost" onClick={() => void bulk('archive')}>
                Archive
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setChecked(new Set())}>
              Clear
            </Button>
          </div>
        )}
        {bulkNote && (
          <p className="border-b border-border px-3 py-1 text-[12.5px] text-text-2" role="status">
            {bulkNote}
          </p>
        )}
        <ul className="flex-1 overflow-y-auto">
          {!loading && !items.length && <li className="p-6 text-center text-[14px] text-text-3">{q ? 'No conversations match your search.' : 'Nothing here.'}</li>}
          {items.map((t) => (
            <li key={t.id} className={`flex border-b border-l-2 border-b-border ${t.slaDueAt && new Date(t.slaDueAt).getTime() <= Date.now() ? 'border-l-danger' : 'border-l-transparent'} ${selected === t.id ? 'bg-accent-soft' : 'hover:bg-surface-2'}`}>
              <input type="checkbox" aria-label={`Select ${t.subject}`} checked={checked.has(t.id)} onChange={() => toggle(t.id)} className="mt-3 ml-2.5 shrink-0" />
              <button onClick={() => void open(t.id)} className="block min-w-0 flex-1 px-3 py-2.5 text-left">
                <div className="flex items-baseline justify-between gap-2">
                  <span className={`truncate text-[14px] ${t.unreadCount ? 'font-semibold' : ''}`}>{who(t.from)}</span>
                  <span className="shrink-0 text-[12px] text-text-3">{shortDate(t.lastMessageAt)}</span>
                </div>
                <p className={`truncate text-[13.5px] ${t.unreadCount ? 'font-medium' : 'text-text-2'}`}>
                  {t.isStarred && <span aria-label="Starred">★ </span>}
                  {t.subject}
                  {t.messageCount > 1 && <span className="text-text-3"> ({t.messageCount})</span>}
                </p>
                <p className="truncate text-[12.5px] text-text-3">
                  {t.hasAttachments && '📎 '}
                  {t.snippet}
                </p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {(mailboxes.data?.length ?? 0) > 1 && <Badge>{t.account.displayName ?? t.account.emailAddress}</Badge>}
                  {t.assignee ? <Badge tone="accent">{t.assignee.name}</Badge> : t.team ? <Badge>{t.team.name}</Badge> : null}
                  {t.tags.map((tag) => (
                    <span key={tag.id} className="rounded px-1.5 py-0.5 text-[11.5px] font-medium text-white" style={{ background: tag.color }}>
                      {tag.name}
                    </span>
                  ))}
                  {t.status !== 'NEW' && t.status !== 'ASSIGNED' && <Badge tone={STATUS_TONE[t.status]}>{STATUS_LABEL[t.status]}</Badge>}
                  {(() => {
                    const due = slaBadge(t.slaDueAt);
                    if (due) return <Badge tone={due.tone}>{due.text}</Badge>;
                    return t.awaitingReplySince && !t.isArchived && !['WAITING_FOR_CLIENT', 'REPLY_NOT_NEEDED', 'CLOSED'].includes(t.status) ? <Badge tone="warning">Awaiting reply</Badge> : null;
                  })()}
                </div>
              </button>
            </li>
          ))}
          {cursor && (
            <li className="p-3 text-center">
              <Button size="sm" pending={loading} onClick={() => void loadList(true, cursor)}>
                Load more
              </Button>
            </li>
          )}
        </ul>
      </section>

      {/* Reading pane */}
      <section className={`min-w-0 flex-1 flex-col overflow-y-auto ${selected || composer ? 'flex' : 'hidden lg:flex'}`} aria-label="Conversation">
        <ErrorBanner error={actionError} />
        {composer && !selected && (
          <div className="p-4">
            <button className="mb-2 text-[13px] text-text-3 hover:text-text lg:hidden" onClick={() => setComposer(null)}>
              ← Back
            </button>
            <Composer initial={composer} onClose={() => setComposer(null)} onSent={() => (setComposer(null), void loadList())} />
          </div>
        )}
        {!selected && !composer && <p className="m-auto text-[14px] text-text-3">Select a conversation</p>}
        {selected && detail && (
          <div className="flex flex-col gap-3 p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <button className="mb-1 text-[13px] text-text-3 hover:text-text lg:hidden" onClick={() => (setSelected(null), setDetail(null))}>
                  ← Back
                </button>
                <h1 className="text-[18px] font-semibold break-words">{detail.subject}</h1>
                <p className="text-[13px] text-text-3">
                  {detail.account.emailAddress} · {STATUS_LABEL[detail.status]} · {detail.priority.toLowerCase()} priority
                </p>
                {presence.length > 0 && (
                  <p className="mt-1 text-[12.5px] font-medium text-warning" role="status">
                    {presence.map((p) => `${p.name} is ${p.state === 'composing' ? 'replying' : 'viewing'}`).join(' · ')}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap gap-1">
                <Button size="sm" variant="ghost" onClick={() => void act('unread')}>
                  Mark unread
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void act(detail.isStarred ? 'unstar' : 'star')}>
                  {detail.isStarred ? 'Unstar' : 'Star'}
                </Button>
                {can('conversation.status') && (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => void act(detail.isArchived ? 'unarchive' : 'archive')}>
                      {detail.isArchived ? 'Move to inbox' : 'Archive'}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void act(detail.isSpam ? 'not-spam' : 'spam')}>
                      {detail.isSpam ? 'Not spam' : 'Spam'}
                    </Button>
                  </>
                )}
                <Select aria-label="Snooze" value="" className="h-8 w-28 text-[13px]" onChange={(e) => e.target.value && void snooze(new Date(e.target.value))}>
                  <option value="">Snooze…</option>
                  {snoozeOptions().map((o) => (
                    <option key={o.label} value={o.at.toISOString()}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </div>
            </div>

            <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_300px]">
            <div className="flex min-w-0 flex-col gap-3">
            {detail.messages.map((m) => (
              <article key={m.id} className="rounded-lg border border-border bg-surface">
                <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-2.5">
                  <div className="min-w-0 text-[13.5px]">
                    <p>
                      <span className="font-semibold">{who(m.from)}</span> <span className="text-text-3">&lt;{m.from.address}&gt;</span>
                      {m.direction === 'OUTBOUND' && m.sentBy && <span className="text-text-3"> · sent by {m.sentBy.name}</span>}
                    </p>
                    <p className="truncate text-[12.5px] text-text-3">
                      to {formatAddresses(m.to) || '—'}
                      {m.cc.length > 0 && ` · cc ${formatAddresses(m.cc)}`}
                      {m.bcc.length > 0 && ` · bcc ${formatAddresses(m.bcc)}`}
                    </p>
                  </div>
                  <time className="text-[12.5px] text-text-3" dateTime={m.receivedAt}>
                    {new Date(m.receivedAt).toLocaleString()}
                  </time>
                </header>
                {m.blockedImages > 0 && !images && (
                  <p className="border-b border-border bg-surface-2 px-4 py-1.5 text-[12.5px] text-text-2">
                    {m.blockedImages} remote image{m.blockedImages === 1 ? '' : 's'} hidden to protect your privacy.{' '}
                    <button className="underline" onClick={() => (setImages(true), void loadDetail(detail.id, true))}>
                      Show images
                    </button>
                  </p>
                )}
                <div className="px-4 py-3">
                  <MessageFrame html={m.html} dark={dark} />
                </div>
                {m.attachments.length > 0 && (
                  <ul className="flex flex-wrap gap-2 border-t border-border px-4 py-2.5">
                    {m.attachments.map((a) => (
                      <li key={a.id}>
                        <a href={`/api/v1/attachments/${a.id}/download`} className="inline-flex items-center gap-1.5 rounded border border-border px-2 py-1 text-[12.5px] hover:bg-surface-2">
                          📎 {a.filename} <span className="text-text-3">{formatBytes(a.sizeBytes)}</span>
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </article>
            ))}

            {composer ? (
              <Composer
                initial={composer}
                onClose={() => setComposer(null)}
                onSent={() => {
                  setComposer(null);
                  void loadDetail(detail.id, images);
                  void loadList();
                }}
              />
            ) : detail.canReply ? (
              <div className="flex gap-2">
                <Button variant="primary" onClick={() => void startDraft({ mode: 'REPLY', threadId: detail.id })}>
                  Reply
                </Button>
                <Button onClick={() => void startDraft({ mode: 'REPLY_ALL', threadId: detail.id })}>Reply all</Button>
                <Button onClick={() => void startDraft({ mode: 'FORWARD', threadId: detail.id })}>Forward</Button>
              </div>
            ) : (
              <p className="text-[13px] text-text-3">You can read this conversation but not reply from {detail.account.emailAddress}.</p>
            )}
            </div>
            <div className="flex flex-col gap-3 xl:order-last">
              {can('ai.use') && ai?.enabled && <AiPanel thread={detail} canReply={detail.canReply} onDraft={(d) => setComposer(d)} />}
              <StatusPanel thread={detail} onChanged={() => (void loadDetail(detail.id, images), void loadList(), void counts.reload())} />
              {(can('contact.read') || can('lead.read') || can('task.read')) && <CrmPanel thread={detail} />}
              <CollabPanel thread={detail} onChanged={() => (void loadDetail(detail.id, images), void loadList())} />
            </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
