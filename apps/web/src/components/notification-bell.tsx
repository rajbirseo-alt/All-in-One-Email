'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { NotificationView } from '@crm/shared';
import { api } from '@/lib/api';
import { useLoad } from '@/lib/hooks';
import { useLiveEvent } from '@/lib/live';
import { shortDate } from '@/lib/mail';

type Page = { items: NotificationView[]; nextCursor: string | null; unread: number };

/** The bell in the header: unread count, the latest notifications, live over the event stream. */
export function NotificationBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const list = useLoad(() => api<Page>('/notifications', { query: { limit: 20 } }), []);
  useLiveEvent('notification', () => void list.reload());

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const unread = list.data?.unread ?? 0;
  const go = async (n: NotificationView) => {
    setOpen(false);
    if (!n.readAt) await api(`/notifications/${n.id}/read`, { method: 'POST' }).catch(() => undefined);
    void list.reload();
    router.push(n.url);
  };

  return (
    <div className="relative" ref={box}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-expanded={open}
        className="relative grid size-8 place-items-center rounded-md text-text-2 hover:bg-surface-2 hover:text-text"
      >
        <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
          <path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8" strokeLinejoin="round" />
          <path d="M10.3 20a1.94 1.94 0 0 0 3.4 0" strokeLinecap="round" />
        </svg>
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-danger px-1 text-center text-[10.5px] leading-4 font-semibold text-white tabular-nums">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-border bg-surface shadow-lg" role="dialog" aria-label="Notifications">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <p className="text-[13.5px] font-semibold">Notifications</p>
            <div className="flex gap-3 text-[12.5px]">
              {unread > 0 && (
                <button className="text-accent hover:underline" onClick={() => void api('/notifications/read-all', { method: 'POST' }).then(() => list.reload())}>
                  Mark all read
                </button>
              )}
              <Link href="/settings/notifications" className="text-text-3 hover:text-text" onClick={() => setOpen(false)}>
                Settings
              </Link>
            </div>
          </div>
          <ul className="max-h-[60vh] overflow-y-auto">
            {!list.data?.items.length && <li className="p-6 text-center text-[13.5px] text-text-3">{list.loading ? 'Loading…' : 'No notifications yet.'}</li>}
            {list.data?.items.map((n) => (
              <li key={n.id} className="border-b border-border last:border-0">
                <button onClick={() => void go(n)} className={`flex w-full gap-2 px-3 py-2.5 text-left hover:bg-surface-2 ${n.readAt ? '' : 'bg-accent-soft/40'}`}>
                  <span className={`mt-1.5 size-2 shrink-0 rounded-full ${n.readAt ? 'bg-transparent' : 'bg-accent'}`} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className={`block text-[13.5px] break-words ${n.readAt ? 'text-text-2' : 'font-medium'}`}>{n.title}</span>
                    {n.body && <span className="block truncate text-[12.5px] text-text-3">{n.body}</span>}
                    <span className="block text-[11.5px] text-text-3">{shortDate(n.createdAt)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
