'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import type { AccountHealthRow, AnalyticsOverview, DepartmentDetail, LeadFunnel, MdDashboard, MyDashboard, ResponseTimeRow, TrendsResult, WorkloadRow } from '@crm/shared';
import { api } from '@/lib/api';
import { useLoad } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { exportUrl, minutes, num, RANGE_LABEL, rangeQuery, updatedText, type RangeKey, type RangeState } from '@/lib/analytics';
import { LEAD_STATUS_LABEL } from '@/lib/crm';
import { STATUS_LABEL } from '@/lib/mail';
import { Badge, Card, ErrorBanner, Input, PageHeader, Select, Table, Td, formatDate } from '@/components/ui';
import { BarList, Funnel, LineChart, Panel, Stat } from '@/components/analytics/charts';

type Tab = 'me' | 'overview' | 'summary';
type Basis = 'business' | 'clock';

export default function DashboardPage() {
  return (
    <Suspense>
      <Dashboard />
    </Suspense>
  );
}

function Dashboard() {
  const { me, can } = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const scope = me.permissions['report.read'];
  const wide = scope === 'ALL' || scope === 'DEPARTMENT' || scope === 'TEAM';
  const tabs: { key: Tab; label: string }[] = [
    ...(wide ? [{ key: 'overview' as Tab, label: 'Overview' }, { key: 'summary' as Tab, label: 'Management summary' }] : []),
    { key: 'me', label: 'My work' },
  ];
  const fallback: Tab = !wide ? 'me' : me.user.role.key === 'MD' ? 'summary' : 'overview';
  const tab = (tabs.find((t) => t.key === params.get('tab'))?.key ?? fallback) as Tab;
  const [r, setR] = useState<RangeState>({ range: tab === 'me' ? 'today' : 'week', from: '', to: '', departmentId: '' });
  const [basis, setBasis] = useState<Basis>('business');
  const depts = useLoad(() => (wide && scope !== 'TEAM' && can('user.read') ? api<DepartmentDetail[]>('/departments') : Promise.resolve([] as DepartmentDetail[])), [wide, scope]);

  if (!scope) {
    return <PageHeader title="Dashboard" description="You do not have access to reports." />;
  }

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={tab === 'me' ? 'Your conversations and replies.' : scope === 'ALL' ? 'Mail, replies and leads across the company.' : scope === 'DEPARTMENT' ? 'Mail, replies and leads in your department.' : 'Mail, replies and leads in your team.'}
      />
      {tabs.length > 1 && (
        <div className="mb-4 flex gap-1 border-b border-border" role="tablist">
          {tabs.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => router.replace(`/dashboard?tab=${t.key}`)}
              className={`-mb-px border-b-2 px-3 py-2 text-[13px] ${tab === t.key ? 'border-accent font-medium text-accent' : 'border-transparent text-text-2 hover:text-text'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
      <Toolbar r={r} setR={setR} basis={basis} setBasis={setBasis} depts={tab === 'me' ? [] : (depts.data ?? [])} exportable={tab !== 'me' && can('report.export')} />
      {tab === 'overview' && <Overview r={r} basis={basis} />}
      {tab === 'summary' && <Summary r={r} basis={basis} />}
      {tab === 'me' && <Mine r={r} basis={basis} />}
    </>
  );
}

// ───────────── filters ─────────────

const EXPORTS: { report: string; label: string }[] = [
  { report: 'productivity', label: 'Employee productivity' },
  { report: 'departments', label: 'Departments' },
  { report: 'accounts', label: 'Mailboxes' },
  { report: 'daily', label: 'Day by day' },
  { report: 'leads', label: 'Lead funnel' },
  { report: 'workload', label: 'Open workload' },
];

function Toolbar({ r, setR, basis, setBasis, depts, exportable }: { r: RangeState; setR: (r: RangeState) => void; basis: Basis; setBasis: (b: Basis) => void; depts: DepartmentDetail[]; exportable: boolean }) {
  const [report, setReport] = useState('productivity');
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <div className="flex flex-wrap rounded-md border border-border bg-surface p-0.5" role="group" aria-label="Period">
        {(Object.keys(RANGE_LABEL) as RangeKey[]).map((k) => (
          <button key={k} onClick={() => setR({ ...r, range: k })} aria-pressed={r.range === k} className={`rounded px-2.5 py-1 text-[13px] ${r.range === k ? 'bg-accent-soft font-medium text-accent' : 'text-text-2 hover:text-text'}`}>
            {RANGE_LABEL[k]}
          </button>
        ))}
      </div>
      {r.range === 'custom' && (
        <span className="flex items-center gap-1.5 text-[13px] text-text-2">
          <Input type="date" aria-label="From" value={r.from} max={r.to || undefined} onChange={(e) => setR({ ...r, from: e.target.value })} className="w-40" />
          to
          <Input type="date" aria-label="To" value={r.to} min={r.from || undefined} onChange={(e) => setR({ ...r, to: e.target.value })} className="w-40" />
        </span>
      )}
      {depts.length > 1 && (
        <Select aria-label="Department" value={r.departmentId} onChange={(e) => setR({ ...r, departmentId: e.target.value })} className="w-48">
          <option value="">All departments</option>
          {depts.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </Select>
      )}
      <Select aria-label="Reply times in" value={basis} onChange={(e) => setBasis(e.target.value as Basis)} className="w-48">
        <option value="business">Reply times: working hours</option>
        <option value="clock">Reply times: clock hours</option>
      </Select>
      {exportable && (
        <span className="ml-auto flex items-center gap-1.5">
          <Select aria-label="Report to export" value={report} onChange={(e) => setReport(e.target.value)} className="w-48">
            {EXPORTS.map((x) => (
              <option key={x.report} value={x.report}>
                {x.label}
              </option>
            ))}
          </Select>
          <a href={exportUrl(r, report)} className="rounded-md border border-border bg-surface px-3 py-1.5 text-[13px] font-medium hover:bg-surface-2" download>
            Export CSV
          </a>
        </span>
      )}
    </div>
  );
}

const avgOf = (x: { avgMinutes: number | null; avgBusinessMinutes: number | null } | undefined, b: Basis) => (x ? (b === 'business' ? x.avgBusinessMinutes : x.avgMinutes) : null);
const firstOf = (x: { avgFirstMinutes: number | null; avgFirstBusinessMinutes: number | null }, b: Basis) => (b === 'business' ? x.avgFirstBusinessMinutes : x.avgFirstMinutes);
const basisNote = (b: Basis) =>
  b === 'business'
    ? 'Reply time counts working hours only (the department’s SLA calendar), from the first unanswered client message to the reply.'
    : 'Reply time counts every hour (nights and weekends too), from the first unanswered client message to the reply.';

function Loading({ error }: { error: { message: string } | null }) {
  return error ? <ErrorBanner error={error} /> : <p className="py-10 text-center text-text-3">Loading…</p>;
}

// ───────────── Overview (CMO / admin / managers) ─────────────

function Overview({ r, basis }: { r: RangeState; basis: Basis }) {
  const q = rangeQuery(r);
  const key = JSON.stringify(q);
  const o = useLoad(() => api<AnalyticsOverview>('/analytics/overview', { query: q }), [key]);
  const depts = useLoad(() => api<ResponseTimeRow[]>('/analytics/response-times', { query: { ...q, groupBy: 'department' } }), [key]);
  const people = useLoad(() => api<ResponseTimeRow[]>('/analytics/response-times', { query: { ...q, groupBy: 'user' } }), [key]);
  const load = useLoad(() => api<WorkloadRow[]>('/analytics/workload', { query: { departmentId: q.departmentId } }), [q.departmentId]);
  const trend = useLoad(() => api<TrendsResult>('/analytics/trends', { query: { metric: 'incoming,replies', interval: 'day', periods: 30, departmentId: q.departmentId } }), [q.departmentId]);
  const funnel = useLoad(() => api<LeadFunnel>('/analytics/leads/funnel', { query: q }), [key]);
  const accounts = useLoad(() => api<AccountHealthRow[]>('/analytics/accounts', { query: q }), [key]);
  const d = o.data;
  if (!d) return <Loading error={o.error} />;

  const keys = [...new Set([...(people.data ?? []).map((p) => p.key), ...(load.data ?? []).map((l) => l.key)])];
  const rows = keys
    .map((k) => ({ k, a: people.data?.find((p) => p.key === k), l: load.data?.find((x) => x.key === k) }))
    .filter((x) => x.k !== null || (x.a?.incoming ?? 0) + (x.l?.open ?? 0) > 0)
    .sort((x, y) => (y.l?.open ?? 0) + (y.a?.replies ?? 0) - ((x.l?.open ?? 0) + (x.a?.replies ?? 0)));

  return (
    <div className="space-y-4">
      <p className="text-[12px] text-text-3">
        {d.from === d.to ? d.from : `${d.from} – ${d.to}`} ({d.timezone}) · {updatedText(d.asOf)}
      </p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
        {d.accounts > 0 && <Stat label="Mailboxes" value={num(d.accounts)} />}
        <Stat label="Incoming" value={num(d.incoming)} hint={`${num(d.newThreads)} new conversations`} />
        <Stat label="Unread now" value={num(d.unread)} />
        <Stat label="Unassigned now" value={num(d.unassigned)} tone={d.unassigned ? 'warning' : undefined} />
        <Stat label="Waiting for reply" value={num(d.pending)} />
        <Stat label="Overdue now" value={num(d.overdue)} tone={d.overdue ? 'danger' : undefined} hint={`${num(d.slaBreaches)} SLA breaches in period`} />
        <Stat label="Avg first reply" value={minutes(firstOf(d.response, basis))} hint={`${num(d.response.replies)} replies · avg ${minutes(avgOf(d.response, basis))}`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Average reply time by department" note={basisNote(basis)}>
          <BarList
            rows={(depts.data ?? []).filter((x) => x.replies > 0).map((x) => ({ key: x.key ?? 'none', label: x.name, value: avgOf(x, basis), detail: `${x.name}: ${minutes(avgOf(x, basis))} average over ${x.replies} replies` }))}
            format={(v) => minutes(v)}
            empty="No replies in this period"
          />
        </Panel>
        <Panel title="Incoming vs replied, last 30 days">
          {trend.data ? (
            <LineChart points={trend.data.points} series={[{ key: 'incoming', label: 'Incoming emails' }, { key: 'replies', label: 'Replies' }]} format={(v) => num(v)} label="Incoming emails and replies per day, last 30 days" />
          ) : (
            <Loading error={trend.error} />
          )}
        </Panel>
      </div>

      <Panel title="Employee productivity" note="Open, waiting and overdue are right now; the other columns are for the selected period.">
        <Table head={['Employee', 'Open', 'Waiting', 'Overdue', 'Incoming', 'Replies', 'Avg reply', 'Avg first reply', 'Closed']}>
          {rows.map(({ k, a, l }) => (
            <tr key={k ?? 'none'}>
              <Td className={k ? 'font-medium' : 'text-text-3'}>{a?.name ?? l?.name}</Td>
              <Td className="tabular-nums">{l?.open ?? 0}</Td>
              <Td className="tabular-nums">{l?.pending ?? 0}</Td>
              <Td className={`tabular-nums ${l?.overdue ? 'text-danger' : ''}`}>{l?.overdue ?? 0}</Td>
              <Td className="tabular-nums">{a?.incoming ?? 0}</Td>
              <Td className="tabular-nums">{a?.replies ?? 0}</Td>
              <Td className="tabular-nums">{minutes(avgOf(a, basis))}</Td>
              <Td className="tabular-nums">{a ? minutes(firstOf(a, basis)) : '—'}</Td>
              <Td className="tabular-nums">{a?.closed ?? 0}</Td>
            </tr>
          ))}
          {!rows.length && (
            <tr>
              <Td className="text-text-3">No conversations in this period</Td>
            </tr>
          )}
        </Table>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Leads created in this period" note={funnel.data && `${funnel.data.total} leads · ${funnel.data.won} won · ${funnel.data.lost} lost${funnel.data.conversionRate !== null ? ` · ${funnel.data.conversionRate}% of closed leads won` : ''}${funnel.data.wonValue.length ? ` · won value ${funnel.data.wonValue.map((v) => `${v.currency} ${num(v.amount)}`).join(', ')}` : ''}`}>
          {funnel.data ? <Funnel stages={funnel.data.reached.map((s) => ({ label: LEAD_STATUS_LABEL[s.status] ?? s.status, count: s.count }))} /> : <Loading error={funnel.error} />}
        </Panel>
        {(accounts.data?.length ?? 0) > 0 && (
          <Panel title="Mailbox health">
            <ul className="divide-y divide-border">
              {accounts.data!.map((a) => (
                <li key={a.id} className="flex items-center gap-3 py-2 text-[13px]">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{a.emailAddress}</span>
                    <span className="block truncate text-[12px] text-text-3">
                      {a.provider} · last sync {formatDate(a.lastSuccessAt)}
                      {a.lastError ? ` · ${a.lastError}` : ''}
                    </span>
                  </span>
                  <span className="text-right text-[12px] text-text-2 tabular-nums">{num(a.incoming)} in</span>
                  {a.status === 'ACTIVE' && !a.failures24h ? <Badge tone="success">✓ Healthy</Badge> : a.status === 'ACTIVE' ? <Badge tone="warning">! {a.failures24h} failed syncs (24h)</Badge> : <Badge tone={a.status === 'PAUSED' ? 'neutral' : 'danger'}>{a.status === 'PAUSED' ? 'Paused' : `✕ ${a.status.replace(/_/g, ' ').toLowerCase()}`}</Badge>}
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </div>
      {d.ai && (
        <p className="text-[12px] text-text-3">
          AI assistant in this period: {num(d.ai.analyses)} analyses, {num(d.ai.inputTokens + d.ai.outputTokens)} tokens ({num(d.ai.inputTokens)} in, {num(d.ai.outputTokens)} out).
        </p>
      )}
    </div>
  );
}

// ───────────── Management summary (MD) ─────────────

function Summary({ r, basis }: { r: RangeState; basis: Basis }) {
  const q = rangeQuery(r);
  const m = useLoad(() => api<MdDashboard>('/analytics/md', { query: q }), [JSON.stringify(q)]);
  const d = m.data;
  if (!d) return <Loading error={m.error} />;
  return (
    <div className="space-y-4">
      <p className="text-[12px] text-text-3">
        {d.from === d.to ? d.from : `${d.from} – ${d.to}`} ({d.timezone}) · {updatedText(d.asOf)}
      </p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <Stat label="Incoming" value={num(d.incoming)} hint={`avg reply ${minutes(avgOf(d.response, basis))}`} />
        <Stat label="Waiting for reply" value={num(d.pending)} />
        <Stat label="Unassigned now" value={num(d.unassigned)} tone={d.unassigned ? 'warning' : undefined} />
        <Stat label="Overdue now" value={num(d.overdue)} tone={d.overdue ? 'danger' : undefined} />
        <Stat label="New leads" value={num(d.newLeads)} />
        <Stat label="Leads won" value={num(d.wonLeads)} />
      </div>
      <Panel title="Departments" note={basisNote(basis)}>
        <Table head={['Department', 'Incoming', 'Replies', 'Avg reply', 'Avg first reply', 'Open now', 'Waiting now', 'Overdue now', 'Closed']}>
          {d.departments.map((x) => (
            <tr key={x.key ?? 'none'}>
              <Td className={x.key ? 'font-medium' : 'text-text-3'}>{x.name}</Td>
              <Td className="tabular-nums">{num(x.incoming)}</Td>
              <Td className="tabular-nums">{num(x.replies)}</Td>
              <Td className="tabular-nums">{minutes(avgOf(x, basis))}</Td>
              <Td className="tabular-nums">{minutes(firstOf(x, basis))}</Td>
              <Td className="tabular-nums">{num(x.open)}</Td>
              <Td className="tabular-nums">{num(x.pending)}</Td>
              <Td className={`tabular-nums ${x.overdue ? 'text-danger' : ''}`}>{num(x.overdue)}</Td>
              <Td className="tabular-nums">{num(x.closed)}</Td>
            </tr>
          ))}
          {!d.departments.length && (
            <tr>
              <Td className="text-text-3">No conversations in this period</Td>
            </tr>
          )}
        </Table>
      </Panel>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Open conversations by department (now)">
          <BarList rows={d.departments.filter((x) => x.open > 0).map((x) => ({ key: x.key ?? 'none', label: x.name, value: x.open, detail: `${x.name}: ${x.open} open, ${x.pending} waiting, ${x.overdue} overdue` }))} format={(v) => num(v)} empty="No open conversations" />
        </Panel>
        <Panel title="Month by month, last 12 months">
          <LineChart interval="month" points={d.monthly} series={[{ key: 'incoming', label: 'Incoming emails' }, { key: 'replies', label: 'Replies' }]} format={(v) => num(v)} label="Incoming emails and replies per month, last 12 months" />
        </Panel>
      </div>
    </div>
  );
}

// ───────────── My work (every employee) ─────────────

function Mine({ r, basis }: { r: RangeState; basis: Basis }) {
  const q = rangeQuery({ ...r, departmentId: '' });
  const m = useLoad(() => api<MyDashboard>('/analytics/me', { query: q }), [JSON.stringify(q)]);
  const d = m.data;
  if (!d) return <Loading error={m.error} />;
  const mine = basis === 'business' ? d.myAvgBusinessMinutes : d.myAvgMinutes;
  const team = basis === 'business' ? d.teamMedianBusinessMinutes : d.teamMedianMinutes;
  return (
    <div className="space-y-4">
      <p className="text-[12px] text-text-3">
        {d.from === d.to ? d.from : `${d.from} – ${d.to}`} · {updatedText(d.asOf)}
      </p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
        <Stat label="Assigned to me" value={num(d.assigned)} hint="open now" />
        <Stat label="Newly assigned" value={num(d.newAssigned)} hint="in this period" />
        <Stat label="Waiting for my reply" value={num(d.pending)} />
        <Stat label="Follow-ups due" value={num(d.followUpsDue + d.tasksDue)} hint={`${d.followUpsDue} conversations · ${d.tasksDue} tasks`} tone={d.followUpsDue + d.tasksDue ? 'warning' : undefined} />
        <Stat label="Overdue" value={num(d.overdue)} tone={d.overdue ? 'danger' : undefined} />
        <Stat label="Closed" value={num(d.closed)} hint="in this period" />
        <Stat label="My avg reply" value={minutes(mine)} hint={team !== null ? `team median ${minutes(team)}` : `${d.replies} replies`} />
      </div>
      <Panel title="Next up" note="Conversations waiting for your reply, the soonest SLA deadline first.">
        {d.nextUp.length ? (
          <ul className="divide-y divide-border">
            {d.nextUp.map((t) => (
              <li key={t.id} className="flex items-center gap-3 py-2 text-[13px]">
                <Link href={`/inbox?thread=${t.id}`} className="min-w-0 flex-1 truncate font-medium hover:underline">
                  {t.subject || '(no subject)'}
                </Link>
                <span className="hidden text-[12px] text-text-3 sm:inline">{STATUS_LABEL[t.status] ?? t.status}</span>
                {t.priority !== 'NORMAL' && t.priority !== 'LOW' && <Badge tone={t.priority === 'URGENT' ? 'danger' : 'warning'}>{t.priority.toLowerCase()}</Badge>}
                {t.slaDueAt ? <Badge tone={t.overdue ? 'danger' : 'neutral'}>{t.overdue ? '✕ overdue since' : 'due'} {formatDate(t.slaDueAt)}</Badge> : <span className="text-[12px] text-text-3">waiting since {formatDate(t.awaitingReplySince)}</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-4 text-center text-text-3">Nothing is waiting for your reply.</p>
        )}
      </Panel>
      <Card className="px-4 py-3 text-[12px] text-text-3">{basisNote(basis)} Team median is the middle of your teammates’ average reply times in this period.</Card>
    </div>
  );
}

