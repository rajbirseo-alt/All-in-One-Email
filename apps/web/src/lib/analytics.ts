/** Dashboard helpers (Phase 9). */

export type RangeKey = 'today' | 'yesterday' | 'week' | 'month' | 'custom';
export interface RangeState {
  range: RangeKey;
  from: string;
  to: string;
  departmentId: string;
}

export const RANGE_LABEL: Record<RangeKey, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  week: 'Last 7 days',
  month: 'Last 30 days',
  custom: 'Custom',
};

/** Query parameters for the analytics endpoints (custom dates only when complete). */
export function rangeQuery(r: RangeState): Record<string, string | undefined> {
  const custom = r.range === 'custom' && r.from && r.to;
  return {
    range: custom ? 'custom' : r.range === 'custom' ? 'week' : r.range,
    from: custom ? r.from : undefined,
    to: custom ? r.to : undefined,
    departmentId: r.departmentId || undefined,
  };
}

export function exportUrl(r: RangeState, report: string) {
  const q = new URLSearchParams(Object.entries({ ...rangeQuery(r), report }).filter(([, v]) => v) as [string, string][]);
  return `/api/v1/analytics/export.csv?${q}`;
}

/** 38m · 4h 05m · 2d 3h */
export function minutes(m: number | null | undefined) {
  if (m === null || m === undefined) return '—';
  if (m < 60) return `${m}m`;
  if (m < 24 * 60) return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
  const d = Math.floor(m / 1440);
  return `${d}d ${Math.floor((m % 1440) / 60)}h`;
}

export const num = (n: number) => new Intl.NumberFormat().format(n);

export function updatedText(asOf: string | null) {
  if (!asOf) return 'Figures are being prepared for the first time; check back in a few minutes.';
  const mins = Math.round((Date.now() - new Date(asOf).getTime()) / 60_000);
  return `Updated ${mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : new Date(asOf).toLocaleString()}`;
}
