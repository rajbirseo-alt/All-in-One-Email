'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import type { PermissionKey } from '@crm/shared';
import { useSession } from '@/lib/session';
import { NotificationBell } from './notification-bell';

/**
 * Navigation lists only modules that are built and that the user may use.
 */
const MAIL_NAV: { href: string; label: string; anyOf: PermissionKey[] }[] = [
  { href: '/dashboard', label: 'Dashboard', anyOf: ['report.read'] },
  { href: '/inbox', label: 'Inbox', anyOf: ['conversation.read'] },
  { href: '/settings/compose', label: 'Signatures & templates', anyOf: ['conversation.reply'] },
];
const CRM_NAV: { href: string; label: string; anyOf: PermissionKey[] }[] = [
  { href: '/contacts', label: 'Contacts', anyOf: ['contact.read'] },
  { href: '/companies', label: 'Companies', anyOf: ['contact.read'] },
  { href: '/leads', label: 'Leads', anyOf: ['lead.read'] },
  { href: '/tasks', label: 'Tasks', anyOf: ['task.read'] },
];
const NAV: { href: string; label: string; anyOf: PermissionKey[] }[] = [
  { href: '/admin/mailboxes', label: 'Mailboxes', anyOf: ['account.connect', 'account.manage'] },
  { href: '/admin/rules', label: 'Routing rules', anyOf: ['rules.manage'] },
  { href: '/admin/sla', label: 'SLA & working hours', anyOf: ['sla.manage'] },
  { href: '/admin/automation', label: 'Automation', anyOf: ['automation.manage'] },
  { href: '/admin/users', label: 'Employees', anyOf: ['user.read'] },
  { href: '/admin/org', label: 'Departments & teams', anyOf: ['user.read', 'org.manage'] },
  { href: '/admin/roles', label: 'Roles & permissions', anyOf: ['role.manage'] },
  { href: '/admin/audit', label: 'Audit log', anyOf: ['audit.read'] },
];

export function AppShell({ children }: { children: ReactNode }) {
  const { me, can, logout } = useSession();
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const items = NAV.filter((n) => n.anyOf.some(can));
  const mailItems = MAIL_NAV.filter((n) => n.anyOf.some(can));
  const crmItems = CRM_NAV.filter((n) => n.anyOf.some(can));
  const fullHeight = path.startsWith('/inbox');
  const link = (n: { href: string; label: string }) => {
    const active = path.startsWith(n.href);
    return (
      <Link
        key={n.href}
        href={n.href}
        onClick={() => setOpen(false)}
        aria-current={active ? 'page' : undefined}
        className={`rounded-md px-2.5 py-1.5 ${active ? 'bg-accent-soft font-medium text-accent' : 'text-text-2 hover:bg-surface-2 hover:text-text'}`}
      >
        {n.label}
      </Link>
    );
  };
  const initials = me.user.name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  const nav = (
    <nav className="flex flex-col gap-0.5 p-3" aria-label="Main">
      {mailItems.length > 0 && (
        <>
          <p className="px-2 pt-1 pb-2 text-[11px] font-semibold tracking-wider text-text-3 uppercase">Mail</p>
          {mailItems.map(link)}
        </>
      )}
      {crmItems.length > 0 && <p className="px-2 pt-4 pb-2 text-[11px] font-semibold tracking-wider text-text-3 uppercase">CRM</p>}
      {crmItems.map(link)}
      {items.length > 0 && <p className="px-2 pt-4 pb-2 text-[11px] font-semibold tracking-wider text-text-3 uppercase">Administration</p>}
      {items.map(link)}
      <p className="px-2 pt-4 pb-2 text-[11px] font-semibold tracking-wider text-text-3 uppercase">You</p>
      <Link
        href="/account"
        onClick={() => setOpen(false)}
        aria-current={path.startsWith('/account') ? 'page' : undefined}
        className={`rounded-md px-2.5 py-1.5 ${path.startsWith('/account') ? 'bg-accent-soft font-medium text-accent' : 'text-text-2 hover:bg-surface-2 hover:text-text'}`}
      >
        My account
      </Link>
      <Link
        href="/settings/notifications"
        onClick={() => setOpen(false)}
        aria-current={path.startsWith('/settings/notifications') ? 'page' : undefined}
        className={`rounded-md px-2.5 py-1.5 ${path.startsWith('/settings/notifications') ? 'bg-accent-soft font-medium text-accent' : 'text-text-2 hover:bg-surface-2 hover:text-text'}`}
      >
        Notifications
      </Link>
    </nav>
  );

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 flex h-12 items-center gap-3 border-b border-border bg-surface px-4">
        <button className="rounded p-1.5 text-text-2 hover:bg-surface-2 lg:hidden" onClick={() => setOpen((o) => !o)} aria-label="Toggle navigation" aria-expanded={open}>
          ☰
        </button>
        <Link href="/" className="flex items-center gap-2 font-semibold">
          <span className="grid size-6 place-items-center rounded bg-accent text-[12px] font-bold text-accent-text">S</span>
          <span className="hidden sm:inline">SEO Discovery CRM</span>
        </Link>
        <div className="ml-auto flex items-center gap-3">
          <NotificationBell />
          <div className="hidden text-right sm:block">
            <p className="text-[13px] leading-tight font-medium">{me.user.name}</p>
            <p className="text-[12px] leading-tight text-text-3">{me.user.role.name}</p>
          </div>
          <span className="grid size-8 place-items-center rounded-full bg-surface-2 text-[12px] font-semibold text-text-2" aria-hidden>
            {initials}
          </span>
          <button onClick={() => void logout()} className="rounded-md px-2 py-1 text-[13px] text-text-2 hover:bg-surface-2 hover:text-text">
            Sign out
          </button>
        </div>
      </header>
      <div className="flex">
        <aside className="sticky top-12 hidden h-[calc(100vh-48px)] w-60 shrink-0 border-r border-border bg-surface lg:block">{nav}</aside>
        {open && (
          <div className="fixed inset-0 top-12 z-10 lg:hidden" onClick={() => setOpen(false)}>
            <aside className="h-full w-64 border-r border-border bg-surface shadow-lg" onClick={(e) => e.stopPropagation()}>
              {nav}
            </aside>
          </div>
        )}
        <main className={fullHeight ? 'h-[calc(100vh-48px)] min-w-0 flex-1 overflow-hidden' : 'min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8'}>{children}</main>
      </div>
    </div>
  );
}
