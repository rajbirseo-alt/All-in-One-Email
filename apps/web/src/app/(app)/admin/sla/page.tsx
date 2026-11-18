'use client';

import { useState } from 'react';
import type { CalendarView, DepartmentDetail, SlaPolicyView } from '@crm/shared';
import { api } from '@/lib/api';
import { useAction, useLoad } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { Badge, Button, Card, Empty, ErrorBanner, Field, Input, Modal, PageHeader, Select } from '@/components/ui';

const DAYS = [
  ['mon', 'Monday'],
  ['tue', 'Tuesday'],
  ['wed', 'Wednesday'],
  ['thu', 'Thursday'],
  ['fri', 'Friday'],
  ['sat', 'Saturday'],
  ['sun', 'Sunday'],
] as const;
type Day = (typeof DAYS)[number][0];
type Hours = CalendarView['weeklyHours'];

const ZONES = ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Australia/Sydney', 'UTC'];
const ACTIONS: Record<string, string> = {
  NOTIFY_ASSIGNEE: 'Tell the assignee',
  REMIND_ASSIGNEE: 'Remind the assignee',
  ALERT_MANAGER: 'Alert team leader / manager',
  ESCALATE: 'Escalate to MD',
};
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];

/** Office hours as a starting point for a new calendar (edit before saving). */
const OFFICE: Hours = { mon: [['09:30', '18:30']], tue: [['09:30', '18:30']], wed: [['09:30', '18:30']], thu: [['09:30', '18:30']], fri: [['09:30', '18:30']], sat: [], sun: [] };

function duration(min: number) {
  if (min === 0) return 'Immediately';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `After ${h ? `${h} h` : ''}${h && m ? ' ' : ''}${m ? `${m} min` : ''}`;
}
const hoursText = (h: Hours) =>
  DAYS.map(([d, label]) => `${label.slice(0, 3)} ${h[d].length ? h[d].map(([a, b]) => `${a}–${b}`).join(', ') : 'closed'}`).join(' · ');

type CalForm = { id: string | null; name: string; timezone: string; weeklyHours: Hours };
type Step = { afterBusinessMinutes: number; action: string; marksOverdue: boolean };
type PolicyForm = { id: string | null; name: string; departmentId: string; priority: string; calendarId: string; isEnabled: boolean; isDefault: boolean; steps: Step[] };

export default function SlaPage() {
  const { me } = useSession();
  const isAll = me.permissions['sla.manage'] === 'ALL';
  const calendars = useLoad(() => api<CalendarView[]>('/calendars'), []);
  const policies = useLoad(() => api<SlaPolicyView[]>('/sla-policies'), []);
  const depts = useLoad(() => api<DepartmentDetail[]>('/departments'), []);
  const [cal, setCal] = useState<CalForm | null>(null);
  const [policy, setPolicy] = useState<PolicyForm | null>(null);
  const [holiday, setHoliday] = useState<Record<string, { date: string; name: string }>>({});

  const saveCal = useAction(async (f: CalForm) => {
    await api(f.id ? `/calendars/${f.id}` : '/calendars', { method: f.id ? 'PUT' : 'POST', body: { name: f.name, timezone: f.timezone, weeklyHours: f.weeklyHours } });
    setCal(null);
    await calendars.reload();
  });
  const savePolicy = useAction(async (f: PolicyForm) => {
    const body = { name: f.name, departmentId: f.departmentId || null, priority: f.priority || null, calendarId: f.calendarId, isEnabled: f.isEnabled, isDefault: f.isDefault, steps: f.steps };
    await api(f.id ? `/sla-policies/${f.id}` : '/sla-policies', { method: f.id ? 'PUT' : 'POST', body });
    setPolicy(null);
    await Promise.all([policies.reload(), calendars.reload()]);
  });
  const act = useAction(async (fn: () => Promise<unknown>) => {
    await fn();
    await Promise.all([calendars.reload(), policies.reload()]);
  });

  const newPolicy = (): PolicyForm => ({
    id: null,
    name: '',
    departmentId: isAll ? '' : (depts.data?.[0]?.id ?? ''),
    priority: '',
    calendarId: calendars.data?.[0]?.id ?? '',
    isEnabled: true,
    isDefault: false,
    steps: [
      { afterBusinessMinutes: 0, action: 'NOTIFY_ASSIGNEE', marksOverdue: false },
      { afterBusinessMinutes: 30, action: 'REMIND_ASSIGNEE', marksOverdue: false },
      { afterBusinessMinutes: 120, action: 'ALERT_MANAGER', marksOverdue: true },
      { afterBusinessMinutes: 1440, action: 'ESCALATE', marksOverdue: false },
    ],
  });
  const setDay = (d: Day, spans: [string, string][]) => setCal((c) => c && { ...c, weeklyHours: { ...c.weeklyHours, [d]: spans } });
  const setStep = (i: number, s: Partial<Step>) => setPolicy((p) => p && { ...p, steps: p.steps.map((x, j) => (j === i ? { ...x, ...s } : s.marksOverdue ? { ...x, marksOverdue: false } : x)) });

  return (
    <>
      <PageHeader
        title="SLA & working hours"
        description="How fast a client must get a reply, counted in working hours only. Reminders and escalations go out automatically; nothing is ever sent to the client."
      />
      <div className="flex flex-col gap-4">
        <ErrorBanner error={calendars.error ?? policies.error ?? act.error} />

        <Card>
          <div className="flex items-center justify-between border-b border-border p-4">
            <div>
              <h2 className="text-[15px] font-semibold">Working hours and holidays</h2>
              <p className="text-[13px] text-text-3">The SLA clock only runs during these hours, in the calendar’s time zone.</p>
            </div>
            {isAll && (
              <Button size="sm" onClick={() => setCal({ id: null, name: '', timezone: 'Asia/Kolkata', weeklyHours: OFFICE })}>
                New calendar
              </Button>
            )}
          </div>
          {!calendars.data?.length ? (
            <Empty title="No working hours yet">{isAll ? 'Add your office hours to start using SLAs.' : 'An administrator needs to add the office hours first.'}</Empty>
          ) : (
            <ul>
              {calendars.data.map((c) => (
                <li key={c.id} className="border-b border-border p-4 last:border-0">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium">
                        {c.name} <span className="font-normal text-text-3">· {c.timezone}</span>
                      </p>
                      <p className="text-[13px] text-text-2">{hoursText(c.weeklyHours)}</p>
                      <p className="text-[12.5px] text-text-3">Used by {c.usedByPolicies} SLA polic{c.usedByPolicies === 1 ? 'y' : 'ies'}</p>
                    </div>
                    {isAll && (
                      <div className="flex gap-1">
                        <Button size="sm" variant="ghost" onClick={() => setCal({ id: c.id, name: c.name, timezone: c.timezone, weeklyHours: c.weeklyHours })}>
                          Edit
                        </Button>
                        <Button size="sm" variant="ghost" disabled={c.usedByPolicies > 0} title={c.usedByPolicies ? 'In use by SLA policies' : undefined} onClick={() => confirm(`Delete ${c.name}?`) && void act.run(() => api(`/calendars/${c.id}`, { method: 'DELETE' }))}>
                          Delete
                        </Button>
                      </div>
                    )}
                  </div>
                  <div className="mt-3">
                    <p className="text-[12px] font-semibold tracking-wide text-text-3 uppercase">Holidays</p>
                    {!c.holidays.length && <p className="text-[13px] text-text-3">None.</p>}
                    <ul className="mt-1 flex flex-wrap gap-1.5">
                      {c.holidays.map((h) => (
                        <li key={h.id} className="inline-flex items-center gap-1.5 rounded border border-border px-2 py-0.5 text-[12.5px]">
                          {new Date(`${h.date}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })} · {h.name}
                          {isAll && (
                            <button aria-label={`Remove ${h.name}`} className="text-text-3 hover:text-danger" onClick={() => void act.run(() => api(`/calendars/${c.id}/holidays/${h.id}`, { method: 'DELETE' }))}>
                              ✕
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                    {isAll && (
                      <form
                        className="mt-2 flex flex-wrap gap-2"
                        onSubmit={(e) => {
                          e.preventDefault();
                          const h = holiday[c.id];
                          if (!h?.date || !h.name.trim()) return;
                          void act.run(async () => {
                            await api(`/calendars/${c.id}/holidays`, { method: 'POST', body: { date: h.date, name: h.name.trim() } });
                            setHoliday((x) => ({ ...x, [c.id]: { date: '', name: '' } }));
                          });
                        }}
                      >
                        <Input type="date" aria-label="Holiday date" className="h-8 w-40" value={holiday[c.id]?.date ?? ''} onChange={(e) => setHoliday((x) => ({ ...x, [c.id]: { name: x[c.id]?.name ?? '', date: e.target.value } }))} />
                        <Input aria-label="Holiday name" placeholder="e.g. Diwali" className="h-8 w-48" value={holiday[c.id]?.name ?? ''} onChange={(e) => setHoliday((x) => ({ ...x, [c.id]: { date: x[c.id]?.date ?? '', name: e.target.value } }))} />
                        <Button size="sm" type="submit" disabled={!holiday[c.id]?.date || !holiday[c.id]?.name.trim()}>
                          Add holiday
                        </Button>
                      </form>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <div className="flex items-center justify-between border-b border-border p-4">
            <div>
              <h2 className="text-[15px] font-semibold">SLA policies</h2>
              <p className="text-[13px] text-text-3">The most specific policy applies: department and priority, then department, then priority, then the default.</p>
            </div>
            <Button size="sm" disabled={!calendars.data?.length} onClick={() => setPolicy(newPolicy())}>
              New policy
            </Button>
          </div>
          {!policies.data?.length ? (
            <Empty title="No SLA policies yet">Without a policy no reply deadline is tracked.</Empty>
          ) : (
            <ul>
              {policies.data.map((p) => (
                <li key={p.id} className="flex flex-wrap items-start justify-between gap-2 border-b border-border p-4 last:border-0">
                  <div className="min-w-0">
                    <p className="font-medium">
                      {p.name} {p.isDefault && <Badge tone="accent">Default</Badge>} {!p.isEnabled && <Badge>Off</Badge>}
                    </p>
                    <p className="text-[13px] text-text-2">
                      {p.isDefault ? 'Every department and priority not covered elsewhere' : `${p.department?.name ?? 'Any department'} · ${p.priority ? `${p.priority.toLowerCase()} priority` : 'any priority'}`} · {p.calendar.name}
                    </p>
                    <ol className="mt-1.5 flex flex-wrap gap-1.5 text-[12.5px]">
                      {p.steps.map((s) => (
                        <li key={s.id} className={`rounded border px-2 py-0.5 ${s.marksOverdue ? 'border-danger/40 bg-danger-soft text-danger' : 'border-border text-text-2'}`}>
                          {duration(s.afterBusinessMinutes)}: {ACTIONS[s.action]}
                          {s.marksOverdue ? ' · overdue' : ''}
                        </li>
                      ))}
                    </ol>
                  </div>
                  {p.canEdit && (
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setPolicy({ id: p.id, name: p.name, departmentId: p.department?.id ?? '', priority: p.priority ?? '', calendarId: p.calendar.id, isEnabled: p.isEnabled, isDefault: p.isDefault, steps: p.steps.map(({ afterBusinessMinutes, action, marksOverdue }) => ({ afterBusinessMinutes, action, marksOverdue })) })
                        }
                      >
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => confirm(`Delete ${p.name}?`) && void act.run(() => api(`/sla-policies/${p.id}`, { method: 'DELETE' }))}>
                        Delete
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Modal
        open={!!cal}
        onClose={() => setCal(null)}
        title={cal?.id ? 'Edit working hours' : 'New working hours'}
        wide
        footer={
          <>
            <Button variant="ghost" onClick={() => setCal(null)}>
              Cancel
            </Button>
            <Button variant="primary" pending={saveCal.pending} disabled={!cal?.name.trim()} onClick={() => cal && void saveCal.run(cal)}>
              Save
            </Button>
          </>
        }
      >
        {cal && (
          <div className="flex flex-col gap-3">
            <ErrorBanner error={saveCal.error} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name" htmlFor="cal-name">
                <Input id="cal-name" value={cal.name} placeholder="e.g. India office" onChange={(e) => setCal({ ...cal, name: e.target.value })} />
              </Field>
              <Field label="Time zone" htmlFor="cal-tz">
                <Select id="cal-tz" value={cal.timezone} onChange={(e) => setCal({ ...cal, timezone: e.target.value })}>
                  {[...new Set([cal.timezone, ...ZONES])].map((z) => (
                    <option key={z} value={z}>
                      {z}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <ul className="flex flex-col gap-2">
              {DAYS.map(([d, label]) => (
                <li key={d} className="flex flex-wrap items-center gap-2">
                  <label className="flex w-32 items-center gap-2 text-[13.5px]">
                    <input type="checkbox" checked={cal.weeklyHours[d].length > 0} onChange={(e) => setDay(d, e.target.checked ? [['09:30', '18:30']] : [])} />
                    {label}
                  </label>
                  {!cal.weeklyHours[d].length && <span className="text-[13px] text-text-3">Closed</span>}
                  {cal.weeklyHours[d].map(([a, b], i) => (
                    <span key={i} className="flex items-center gap-1">
                      <Input type="time" aria-label={`${label} opens`} className="h-8 w-28" value={a} onChange={(e) => setDay(d, cal.weeklyHours[d].map((s, j) => (j === i ? [e.target.value, s[1]] : s)))} />
                      –
                      <Input type="time" aria-label={`${label} closes`} className="h-8 w-28" value={b === '24:00' ? '23:59' : b} onChange={(e) => setDay(d, cal.weeklyHours[d].map((s, j) => (j === i ? [s[0], e.target.value] : s)))} />
                      {cal.weeklyHours[d].length > 1 && (
                        <button aria-label="Remove these hours" className="px-1 text-text-3 hover:text-danger" onClick={() => setDay(d, cal.weeklyHours[d].filter((_, j) => j !== i))}>
                          ✕
                        </button>
                      )}
                    </span>
                  ))}
                  {cal.weeklyHours[d].length > 0 && cal.weeklyHours[d].length < 4 && (
                    <button className="text-[12.5px] text-text-3 underline" onClick={() => setDay(d, [...cal.weeklyHours[d], ['14:00', '18:00']])}>
                      + split (e.g. lunch break)
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Modal>

      <Modal
        open={!!policy}
        onClose={() => setPolicy(null)}
        title={policy?.id ? 'Edit SLA policy' : 'New SLA policy'}
        wide
        footer={
          <>
            <Button variant="ghost" onClick={() => setPolicy(null)}>
              Cancel
            </Button>
            <Button variant="primary" pending={savePolicy.pending} disabled={!policy?.name.trim() || !policy?.calendarId} onClick={() => policy && void savePolicy.run(policy)}>
              Save
            </Button>
          </>
        }
      >
        {policy && (
          <div className="flex flex-col gap-3">
            <ErrorBanner error={savePolicy.error} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name" htmlFor="p-name">
                <Input id="p-name" value={policy.name} placeholder="e.g. Sales enquiries" onChange={(e) => setPolicy({ ...policy, name: e.target.value })} />
              </Field>
              <Field label="Working hours" htmlFor="p-cal">
                <Select id="p-cal" value={policy.calendarId} onChange={(e) => setPolicy({ ...policy, calendarId: e.target.value })}>
                  {calendars.data?.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.timezone})
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Department" htmlFor="p-dept">
                <Select id="p-dept" value={policy.departmentId} disabled={policy.isDefault} onChange={(e) => setPolicy({ ...policy, departmentId: e.target.value })}>
                  {isAll && <option value="">Any department</option>}
                  {depts.data?.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Priority" htmlFor="p-prio">
                <Select id="p-prio" value={policy.priority} disabled={policy.isDefault} onChange={(e) => setPolicy({ ...policy, priority: e.target.value })}>
                  <option value="">Any priority</option>
                  {PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {p.charAt(0) + p.slice(1).toLowerCase()}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="flex flex-wrap gap-4 text-[13.5px]">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={policy.isEnabled} onChange={(e) => setPolicy({ ...policy, isEnabled: e.target.checked })} /> On
              </label>
              {isAll && (
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={policy.isDefault} onChange={(e) => setPolicy({ ...policy, isDefault: e.target.checked, departmentId: e.target.checked ? '' : policy.departmentId, priority: e.target.checked ? '' : policy.priority })} /> Default policy (applies when no other policy fits)
                </label>
              )}
            </div>
            <div>
              <p className="mb-1 text-[13px] font-medium">Steps, counted in working time from the client’s unanswered email</p>
              <ul className="flex flex-col gap-2">
                {policy.steps.map((s, i) => (
                  <li key={i} className="flex flex-wrap items-center gap-2 text-[13.5px]">
                    <span className="flex items-center gap-1">
                      After
                      <Input type="number" min={0} aria-label="Hours" className="h-8 w-20" value={Math.floor(s.afterBusinessMinutes / 60)} onChange={(e) => setStep(i, { afterBusinessMinutes: Math.max(0, Number(e.target.value) || 0) * 60 + (s.afterBusinessMinutes % 60) })} />
                      h
                      <Input type="number" min={0} max={59} aria-label="Minutes" className="h-8 w-20" value={s.afterBusinessMinutes % 60} onChange={(e) => setStep(i, { afterBusinessMinutes: Math.floor(s.afterBusinessMinutes / 60) * 60 + Math.min(59, Math.max(0, Number(e.target.value) || 0)) })} />
                      min
                    </span>
                    <Select aria-label="Action" className="h-8 w-56" value={s.action} onChange={(e) => setStep(i, { action: e.target.value })}>
                      {Object.entries(ACTIONS).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v}
                        </option>
                      ))}
                    </Select>
                    <label className="flex items-center gap-1.5">
                      <input type="radio" name="overdue" checked={s.marksOverdue} onChange={() => setStep(i, { marksOverdue: true })} /> Overdue from here
                    </label>
                    {policy.steps.length > 1 && (
                      <button aria-label="Remove step" className="px-1 text-text-3 hover:text-danger" onClick={() => setPolicy({ ...policy, steps: policy.steps.filter((_, j) => j !== i) })}>
                        ✕
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {policy.steps.length < 10 && (
                <button className="mt-2 text-[13px] text-accent underline" onClick={() => setPolicy({ ...policy, steps: [...policy.steps, { afterBusinessMinutes: 240, action: 'REMIND_ASSIGNEE', marksOverdue: false }] })}>
                  + Add step
                </button>
              )}
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
