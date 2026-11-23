'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { TrendPoint } from '@crm/shared';
import { Card } from '@/components/ui';

/** Headline number with a label and an optional secondary line. */
export function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: ReactNode; tone?: 'danger' | 'warning' }) {
  return (
    <Card className="px-4 py-3">
      <p className="text-[12px] font-medium text-text-2">{label}</p>
      <p className={`mt-1 text-[22px] leading-tight font-semibold tabular-nums ${tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : ''}`}>{value}</p>
      {hint && <p className="mt-0.5 text-[12px] text-text-3">{hint}</p>}
    </Card>
  );
}

export function Panel({ title, actions, children, note }: { title: string; actions?: ReactNode; children: ReactNode; note?: ReactNode }) {
  return (
    <Card className="min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <h2 className="text-[14px] font-semibold">{title}</h2>
        {actions}
      </div>
      <div className="p-4">{children}</div>
      {note && <p className="border-t border-border px-4 py-2 text-[12px] text-text-3">{note}</p>}
    </Card>
  );
}

/**
 * Horizontal bars, one series (the panel title names it, so no legend). Values are written at the
 * end of each bar in text colour; hovering a row shows the full detail.
 */
export function BarList({ rows, format, empty = 'No data for this period' }: { rows: { key: string; label: string; value: number | null; detail?: string }[]; format: (v: number) => string; empty?: string }) {
  const max = Math.max(0, ...rows.map((r) => r.value ?? 0));
  if (!rows.length) return <p className="py-6 text-center text-text-3">{empty}</p>;
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.key} className="group grid grid-cols-[minmax(80px,30%)_1fr] items-center gap-3" title={r.detail ?? `${r.label}: ${r.value === null ? 'no data' : format(r.value)}`}>
          <span className="truncate text-[13px] text-text-2">{r.label}</span>
          <span className="flex items-center gap-2">
            <span className="h-3 flex-1 rounded-sm group-hover:bg-surface-2">
              {r.value !== null && max > 0 && <span className="block h-3 rounded-r-[4px] bg-series-1" style={{ width: `${Math.max(1, (r.value / max) * 100)}%` }} />}
            </span>
            <span className="w-16 text-right text-[13px] tabular-nums">{r.value === null ? '—' : format(r.value)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, Math.floor(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

const SERIES_COLORS = ['var(--series-1)', 'var(--series-2)'];

/**
 * Up to two series over time on one axis (same unit). Legend above, end-of-line labels, a
 * crosshair + tooltip on hover/focus, and a table view for exact values.
 */
export function LineChart({ points, series, format, label, interval = 'day' }: { points: TrendPoint[]; series: { key: string; label: string }[]; format: (v: number) => string; label: string; interval?: 'day' | 'week' | 'month' }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const H = 200;
  const pad = { l: 40, r: 64, t: 10, b: 24 };
  const iw = width - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const vals = points.flatMap((p) => series.map((s) => p.values[s.key] ?? 0));
  const rawMax = Math.max(1, ...vals);
  const step = niceStep(rawMax / 4);
  const max = Math.ceil(rawMax / step) * step;
  const x = (i: number) => pad.l + (points.length <= 1 ? iw / 2 : (i / (points.length - 1)) * iw);
  const y = (v: number) => pad.t + ih - (v / max) * ih;
  const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step);
  const labelEvery = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(iw / 70))));
  const fmtBucket = (b: string) => new Date(`${b}T00:00:00`).toLocaleDateString(undefined, interval === 'month' ? { month: 'short', year: '2-digit' } : { day: 'numeric', month: 'short' });

  if (!points.length) return <p className="py-6 text-center text-text-3">No data for this period</p>;
  const last = points.length - 1;
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-4 text-[12px] text-text-2">
        {series.map((s, i) => (
          <span key={s.key} className="flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-4 rounded" style={{ background: SERIES_COLORS[i] }} aria-hidden />
            {s.label}
          </span>
        ))}
        <button className="ml-auto rounded px-1.5 py-0.5 text-accent hover:bg-accent-soft" onClick={() => setTable((t) => !t)}>
          {table ? 'Show chart' : 'Show table'}
        </button>
      </div>
      {table ? (
        <div className="max-h-64 overflow-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-text-3">
                <th className="py-1 font-medium">Date</th>
                {series.map((s) => (
                  <th key={s.key} className="py-1 text-right font-medium">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.bucket} className="border-t border-border">
                  <td className="py-1">{fmtBucket(p.bucket)}</td>
                  {series.map((s) => (
                    <td key={s.key} className="py-1 text-right tabular-nums">
                      {p.values[s.key] === null || p.values[s.key] === undefined ? '—' : format(p.values[s.key]!)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div ref={ref} className="relative">
          <svg
            width={width}
            height={H}
            role="img"
            aria-label={label}
            tabIndex={0}
            className="block outline-none focus-visible:ring-2 focus-visible:ring-focus"
            onMouseMove={(e) => {
              const box = e.currentTarget.getBoundingClientRect();
              const px = e.clientX - box.left;
              setHover(points.length <= 1 ? 0 : Math.min(last, Math.max(0, Math.round(((px - pad.l) / iw) * last))));
            }}
            onMouseLeave={() => setHover(null)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight') setHover((h) => Math.min(last, (h ?? -1) + 1));
              if (e.key === 'ArrowLeft') setHover((h) => Math.max(0, (h ?? last + 1) - 1));
            }}
            onBlur={() => setHover(null)}
          >
            {ticks.map((t) => (
              <g key={t}>
                <line x1={pad.l} x2={pad.l + iw} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth={1} />
                <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--text-3)">
                  {format(t)}
                </text>
              </g>
            ))}
            {points.map((p, i) =>
              i % labelEvery === 0 || i === last ? (
                <text key={p.bucket} x={x(i)} y={H - 6} textAnchor={i === 0 ? 'start' : i === last ? 'end' : 'middle'} fontSize={11} fill="var(--text-3)">
                  {fmtBucket(p.bucket)}
                </text>
              ) : null,
            )}
            {series.map((s, si) => {
              const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.values[s.key] ?? 0).toFixed(1)}`).join(' ');
              const endV = points[last]!.values[s.key] ?? 0;
              return (
                <g key={s.key}>
                  <path d={d} fill="none" stroke={SERIES_COLORS[si]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                  <text x={x(last) + 6} y={y(endV) + 4 + (series.length > 1 && si === 1 ? endLabelNudge(points, series, y) : 0)} fontSize={11} fill="var(--text-2)">
                    {s.label.split(' ')[0]}
                  </text>
                </g>
              );
            })}
            {hover !== null && (
              <g>
                <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + ih} stroke="var(--text-3)" strokeWidth={1} strokeDasharray="3 3" />
                {series.map((s, si) => (
                  <circle key={s.key} cx={x(hover)} cy={y(points[hover]!.values[s.key] ?? 0)} r={4} fill={SERIES_COLORS[si]} stroke="var(--surface)" strokeWidth={2} />
                ))}
              </g>
            )}
          </svg>
          {hover !== null && (
            <div
              className="pointer-events-none absolute top-1 z-10 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[12px] shadow-md"
              style={{ left: Math.min(Math.max(0, x(hover) + 10), width - 160) }}
              role="status"
            >
              <p className="font-medium">{fmtBucket(points[hover]!.bucket)}</p>
              {series.map((s, si) => (
                <p key={s.key} className="flex items-center gap-1.5 text-text-2">
                  <span className="inline-block size-2 rounded-full" style={{ background: SERIES_COLORS[si] }} aria-hidden />
                  {s.label}: <span className="text-text tabular-nums">{points[hover]!.values[s.key] === null ? '—' : format(points[hover]!.values[s.key] ?? 0)}</span>
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Keeps the two end-of-line labels from overlapping. */
function endLabelNudge(points: TrendPoint[], series: { key: string }[], y: (v: number) => number) {
  const p = points[points.length - 1]!;
  const a = y(p.values[series[0]!.key] ?? 0);
  const b = y(p.values[series[1]!.key] ?? 0);
  if (Math.abs(a - b) >= 12) return 0;
  return b >= a ? 12 - (b - a) : -(12 - (a - b));
}

function niceStep(raw: number) {
  if (raw <= 1) return 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  const n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

/** Lead funnel: stages reached, one series, with the count and share of the first stage. */
export function Funnel({ stages }: { stages: { label: string; count: number }[] }) {
  const top = stages[0]?.count ?? 0;
  if (!top) return <p className="py-6 text-center text-text-3">No leads were created in this period</p>;
  return (
    <ul className="space-y-1.5">
      {stages.map((s) => (
        <li key={s.label} className="grid grid-cols-[110px_1fr_70px] items-center gap-3 text-[13px]" title={`${s.label}: ${s.count} of ${top} (${Math.round((s.count / top) * 100)}%)`}>
          <span className="truncate text-text-2">{s.label}</span>
          <span className="h-3 rounded-sm">
            {s.count > 0 && <span className="block h-3 rounded-r-[4px] bg-series-1" style={{ width: `${(s.count / top) * 100}%` }} />}
          </span>
          <span className="text-right tabular-nums">
            {s.count} <span className="text-text-3">({Math.round((s.count / top) * 100)}%)</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
