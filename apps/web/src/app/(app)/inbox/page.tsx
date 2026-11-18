'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { DraftView, MailboxSummary, ThreadCounts, ThreadDetail, ThreadListItem } from '@crm/shared';
import { api, ApiError } from '@/lib/api';
import { useLoad } from '@/lib/hooks';
import { formatAddresses, formatBytes, prefersDark, shortDate, who } from '@/lib/mail';
import { useSession } from '@/lib/session';
import { Badge, Button, ErrorBanner, Input, Select } from '@/components/ui';
import { Composer } from '@/components/mail/composer';
import { MessageFrame } from '@/components/mail/message-frame';

const VIEWS: { key: string; label: string }[] = [
  { key: 'inbox', label: 'Inbox' },
  { key: 'mine', label: 'Assigned to me' },
  { key: 'unassigned', label: 'Unassigned' },
  { key: 'unread', label: 'Unread' },
  { key: 'pending', label: 'Awaiting reply' },
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

export default function InboxPage() {
  const { can } = useSession();
  const router = useRouter();
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

  // Live updates: refresh the list, counts and the open conversation when they change.
  useEffect(() => {
    const es = new EventSource('/api/v1/events');
    let t: ReturnType<typeof setTimeout> | null = null;
    es.addEventListener('thread.updated', (ev) => {
      const ids = (JSON.parse((ev as MessageEvent).data) as { threadIds: string[] }).threadIds;
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        void loadList();
        void counts.reload();
        if (selectedRef.current && ids.includes(selectedRef.current)) void loadDetail(selectedRef.current, false);
      }, 400);
    });
    es.addEventListener('session.ended', () => {
      es.close();
      router.replace('/login');
    });
    return () => {
      es.close();
      if (t) clearTimeout(t);
    };
  }, [loadList, loadDetail, counts, router]);

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
        <ul className="flex-1 overflow-y-auto">
          {!loading && !items.length && <li className="p-6 text-center text-[14px] text-text-3">{q ? 'No conversations match your search.' : 'Nothing here.'}</li>}
          {items.map((t) => (
            <li key={t.id}>
              <button onClick={() => void open(t.id)} className={`block w-full border-b border-border px-3 py-2.5 text-left ${selected === t.id ? 'bg-accent-soft' : 'hover:bg-surface-2'}`}>
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
                  {t.assignee && <Badge tone="accent">{t.assignee.name}</Badge>}
                  {t.awaitingReplySince && !t.isArchived && <Badge tone="warning">Awaiting reply</Badge>}
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
                  {detail.account.emailAddress} · {detail.status.replace(/_/g, ' ').toLowerCase()}
                </p>
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
        )}
      </section>
    </div>
  );
}
