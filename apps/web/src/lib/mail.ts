import type { Participant } from '@crm/shared';

export const who = (p: Participant | null | undefined) => (p ? p.name || p.address : 'Unknown sender');

/** "10:42", "Tue", "12 Nov" or "12 Nov 2025" depending on age. */
export function shortDate(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const days = (now.getTime() - d.getTime()) / 86_400_000;
  if (days < 6) return d.toLocaleDateString(undefined, { weekday: 'short' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatAddresses(list: Participant[]) {
  return list.map((p) => (p.name ? `${p.name} <${p.address}>` : p.address)).join(', ');
}

/** Parses "Name <a@b>, c@d" into recipients; returns the invalid parts separately. */
export function parseAddresses(input: string): { list: Participant[]; invalid: string[] } {
  const list: Participant[] = [];
  const invalid: string[] = [];
  for (const raw of input.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean)) {
    const m = /^(.*)<([^>]+)>$/.exec(raw);
    const address = (m ? m[2]! : raw).trim().toLowerCase();
    const name = m ? m[1]!.trim().replace(/^"|"$/g, '') || null : null;
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) list.push({ address, name });
    else invalid.push(raw);
  }
  return { list, invalid };
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function prefersDark() {
  if (typeof document === 'undefined') return false;
  const forced = document.documentElement.dataset.theme;
  if (forced) return forced === 'dark';
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

// ── Status and SLA (Phase 6) ──
export const STATUS_LABEL: Record<string, string> = {
  NEW: 'New',
  ASSIGNED: 'Assigned',
  IN_PROGRESS: 'In progress',
  WAITING_FOR_CLIENT: 'Waiting for client',
  PENDING_REPLY: 'Pending reply',
  FOLLOW_UP_REQUIRED: 'Follow-up',
  REPLY_NOT_NEEDED: 'Reply not needed',
  CLOSED: 'Closed',
};
export const STATUS_TONE: Record<string, 'neutral' | 'accent' | 'success' | 'warning' | 'danger'> = {
  NEW: 'accent',
  ASSIGNED: 'accent',
  IN_PROGRESS: 'warning',
  WAITING_FOR_CLIENT: 'neutral',
  PENDING_REPLY: 'warning',
  FOLLOW_UP_REQUIRED: 'warning',
  REPLY_NOT_NEEDED: 'neutral',
  CLOSED: 'success',
};

/** "in 1 h 12 min" / "3 h 5 min ago" (wall-clock time, for the due badge). */
export function relative(ms: number) {
  const abs = Math.abs(ms);
  const d = Math.floor(abs / 86_400_000);
  const h = Math.floor((abs % 86_400_000) / 3_600_000);
  const m = Math.floor((abs % 3_600_000) / 60_000);
  const text = d ? `${d} d${h ? ` ${h} h` : ''}` : h ? `${h} h${m ? ` ${m} min` : ''}` : `${Math.max(m, 1)} min`;
  return ms >= 0 ? `in ${text}` : `${text} ago`;
}

/** Badge for the reply deadline: overdue, due soon (under an hour) or due later. */
export function slaBadge(dueAt: string | null, now = Date.now()): { text: string; tone: 'danger' | 'warning' | 'neutral' } | null {
  if (!dueAt) return null;
  const left = new Date(dueAt).getTime() - now;
  if (left <= 0) return { text: `Overdue ${relative(left).replace(' ago', '')}`, tone: 'danger' };
  return { text: `Reply due ${relative(left)}`, tone: left < 3_600_000 ? 'warning' : 'neutral' };
}
