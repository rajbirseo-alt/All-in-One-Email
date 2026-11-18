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
