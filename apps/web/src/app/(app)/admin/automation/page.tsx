'use client';

import Link from 'next/link';
import { useState } from 'react';
import {
  AI_CATEGORIES,
  AI_SENTIMENTS,
  AI_TONES,
  AI_URGENCIES,
  AUTOMATION_STATUSES,
  type AutomationRuleView,
  type AutomationRunView,
  type AutomationTestResult,
  type DepartmentDetail,
  type MailboxSummary,
  type Page,
  type TagView,
  type ThreadListItem,
  type UserSummary,
} from '@crm/shared';
import { api, ApiError } from '@/lib/api';
import { AI_TONE_LABEL, CATEGORY_LABEL, useAiStatus } from '@/lib/ai';
import { useLoad } from '@/lib/hooks';
import { shortDate, STATUS_LABEL } from '@/lib/mail';
import { useSession } from '@/lib/session';
import { Badge, Button, Card, Empty, ErrorBanner, Field, Input, Modal, PageHeader, Select } from '@/components/ui';

const TRIGGER: Record<string, { label: string; hint: string }> = {
  MESSAGE_RECEIVED: { label: 'New email arrives', hint: 'After routing and, when AI is on, after the AI has read it, so AI category and urgency can be used.' },
  LEAD_DETECTED: { label: 'AI detects a sales lead', hint: 'When the AI is at least 70% sure a new email is a business enquiry.' },
  USER_ABSENT: { label: 'Employee marked absent', hint: 'When someone (or their manager) turns on “away”. Use it to hand their open conversations to colleagues.' },
};
const FIELD: Record<string, string> = {
  mailbox: 'Mailbox',
  from: 'Sender address',
  fromDomain: 'Sender domain',
  to: 'Recipients',
  subject: 'Subject',
  body: 'Message text',
  priority: 'Priority',
  status: 'Status',
  category: 'AI category',
  urgency: 'AI urgency',
  sentiment: 'AI sentiment',
  assigned: 'Has an assignee',
  assigneeAbsent: 'Assignee is away',
};
const OPS: Record<string, string> = { is: 'is', contains: 'contains', notContains: 'does not contain', startsWith: 'starts with', endsWith: 'ends with' };
const ACTION: Record<string, string> = {
  assign: 'Assign',
  set_priority: 'Set priority',
  set_status: 'Set status',
  add_tag: 'Add tag',
  notify: 'Notify',
  create_task: 'Create a task',
  create_lead: 'Open a sales lead',
  request_ai_draft: 'Write an AI reply draft (for review)',
  reassign_absent: 'Reassign their open conversations',
};
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];

type Cond = { field: string; op: string; value: string };
type Action = { type: string } & Record<string, unknown>;
interface Form {
  id: string | null;
  name: string;
  description: string;
  trigger: string;
  departmentId: string;
  isEnabled: boolean;
  match: 'all' | 'any';
  conditions: Cond[];
  actions: Action[];
}
const blank = (departmentId = ''): Form => ({ id: null, name: '', description: '', trigger: 'MESSAGE_RECEIVED', departmentId, isEnabled: false, match: 'all', conditions: [], actions: [{ type: 'set_priority', priority: 'HIGH' }] });
const defaults: Record<string, Action> = {
  assign: { type: 'assign', targetType: 'TEAM', teamId: '', strategy: 'ROUND_ROBIN' },
  set_priority: { type: 'set_priority', priority: 'HIGH' },
  set_status: { type: 'set_status', status: 'IN_PROGRESS' },
  add_tag: { type: 'add_tag', tagId: '' },
  notify: { type: 'notify', to: 'assignee', userIds: [], message: '' },
  create_task: { type: 'create_task', title: '', dueInHours: 24, assignTo: 'assignee' },
  create_lead: { type: 'create_lead', serviceInterest: '' },
  request_ai_draft: { type: 'request_ai_draft', tone: 'professional', instructions: '' },
  reassign_absent: { type: 'reassign_absent', to: 'pool' },
};

export default function AutomationPage() {
  const { me } = useSession();
  const isAll = me.permissions['automation.manage'] === 'ALL';
  const ai = useAiStatus();
  const rules = useLoad(() => api<AutomationRuleView[]>('/automation-rules'), []);
  const mailboxes = useLoad(() => api<MailboxSummary[]>('/accounts'), []);
  const depts = useLoad(() => api<DepartmentDetail[]>('/departments'), []);
  const users = useLoad(() => api<Page<UserSummary>>('/users', { query: { limit: 100, status: 'ACTIVE' } }), []);
  const tags = useLoad(() => api<TagView[]>('/tags'), []);
  const [form, setForm] = useState<Form | null>(null);
  const [runsFor, setRunsFor] = useState<AutomationRuleView | null>(null);
  const [testFor, setTestFor] = useState<AutomationRuleView | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [saving, setSaving] = useState(false);
  const fe = error?.fieldErrors() ?? {};
  const teams = depts.data?.flatMap((d) => d.teams) ?? [];
  const people = users.data?.items ?? [];
  const deptName = (id: string) => depts.data?.find((d) => d.id === id)?.name ?? 'department';

  const describeAction = (a: Action) => {
    const name = (id: unknown) => people.find((u) => u.id === id)?.name ?? 'someone';
    switch (a.type) {
      case 'assign':
        return a.targetType === 'USER' ? `Assign to ${name(a.targetUserId)}` : a.targetType === 'TEAM' ? `Assign to team ${teams.find((t) => t.id === a.teamId)?.name ?? ''}` : `Assign to ${deptName(String(a.departmentId))}`;
      case 'set_priority':
        return `Priority ${String(a.priority).toLowerCase()}`;
      case 'set_status':
        return `Status ${STATUS_LABEL[String(a.status)] ?? a.status}`;
      case 'add_tag':
        return `Tag ${tags.data?.find((t) => t.id === a.tagId)?.name ?? ''}`;
      case 'notify':
        return `Notify ${a.to === 'users' ? (a.userIds as string[]).map(name).join(', ') : String(a.to).replace('_', ' ')}`;
      case 'create_task':
        return `Task “${a.title}”`;
      default:
        return ACTION[a.type] ?? a.type;
    }
  };

  const save = async () => {
    if (!form) return;
    setSaving(true);
    setError(null);
    try {
      const body = {
        name: form.name,
        description: form.description || null,
        trigger: form.trigger,
        departmentId: form.departmentId || null,
        isEnabled: form.isEnabled,
        conditions: { match: form.match, conditions: form.trigger === 'USER_ABSENT' ? [] : form.conditions },
        actions: form.actions.map((a) => Object.fromEntries(Object.entries(a).filter(([, v]) => v !== ''))),
      };
      await api(form.id ? `/automation-rules/${form.id}` : '/automation-rules', { method: form.id ? 'PUT' : 'POST', body });
      setForm(null);
      await rules.reload();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setSaving(false);
    }
  };
  const toggle = async (r: AutomationRuleView) => {
    setError(null);
    try {
      await api(`/automation-rules/${r.id}/${r.isEnabled ? 'disable' : 'enable'}`, { method: 'POST' });
      await rules.reload();
    } catch (e) {
      setError(e as ApiError);
    }
  };
  const remove = async (r: AutomationRuleView) => {
    if (!confirm(`Delete the automation “${r.name}”? Its run log is deleted too.`)) return;
    await api(`/automation-rules/${r.id}`, { method: 'DELETE' }).catch((e) => setError(e as ApiError));
    await rules.reload();
  };
  const edit = (r: AutomationRuleView) =>
    setForm({ id: r.id, name: r.name, description: r.description ?? '', trigger: r.trigger, departmentId: r.department?.id ?? '', isEnabled: r.isEnabled, match: r.conditions.match, conditions: r.conditions.conditions, actions: r.actions });

  const setAction = (i: number, patch: Record<string, unknown>) => form && setForm({ ...form, actions: form.actions.map((a, k) => (k === i ? { ...a, ...patch } : a)) });
  const setCond = (i: number, patch: Partial<Cond>) => form && setForm({ ...form, conditions: form.conditions.map((c, k) => (k === i ? { ...c, ...patch } : c)) });
  const actionTypes = form?.trigger === 'USER_ABSENT' ? ['reassign_absent', 'notify'] : Object.keys(ACTION).filter((t) => t !== 'reassign_absent' && (t !== 'request_ai_draft' || ai?.enabled));

  const valueInput = (c: Cond, i: number) => {
    const sel = (opts: [string, string][]) => (
      <Select aria-label="Value" className="h-8 text-[13px]" value={c.value} onChange={(e) => setCond(i, { value: e.target.value })}>
        <option value="">Choose…</option>
        {opts.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </Select>
    );
    if (c.field === 'mailbox') return sel((mailboxes.data ?? []).map((m) => [m.id, m.emailAddress]));
    if (c.field === 'priority') return sel(PRIORITIES.map((p) => [p, p.toLowerCase()]));
    if (c.field === 'status') return sel(Object.entries(STATUS_LABEL));
    if (c.field === 'category') return sel(AI_CATEGORIES.map((x) => [x, CATEGORY_LABEL[x] ?? x]));
    if (c.field === 'urgency') return sel(AI_URGENCIES.map((x) => [x, x.toLowerCase()]));
    if (c.field === 'sentiment') return sel(AI_SENTIMENTS.map((x) => [x, x.toLowerCase()]));
    if (c.field === 'assigned' || c.field === 'assigneeAbsent') return sel([['yes', 'yes'], ['no', 'no']]);
    return <Input aria-label="Value" className="h-8 text-[13px]" value={c.value} onChange={(e) => setCond(i, { value: e.target.value })} />;
  };
  const userSelect = (value: unknown, onChange: (v: string) => void, label = 'Employee') => (
    <Select aria-label={label} className="h-8 text-[13px]" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
      <option value="">Choose…</option>
      {people.map((u) => (
        <option key={u.id} value={u.id}>
          {u.name}
        </option>
      ))}
    </Select>
  );

  return (
    <>
      <PageHeader
        title="Automation"
        description="Rules that act on new mail, detected leads and absences. They can assign, tag, prioritise, notify, create tasks and leads, and prepare AI drafts. No rule can send an email: drafts always wait for a person to press Send."
        actions={
          <Button variant="primary" onClick={() => (setError(null), setForm(blank(isAll ? '' : (depts.data?.[0]?.id ?? ''))))}>
            New rule
          </Button>
        }
      />
      {!ai?.enabled && ai && <p className="mb-3 rounded-md bg-surface-2 px-3 py-2 text-[13px] text-text-2">AI is not set up on the server, so AI conditions stay empty and the AI-draft action is not offered. Rules without AI work normally.</p>}
      <ErrorBanner error={!form ? (error ?? rules.error) : null} />
      <div className="flex flex-col gap-3">
        {rules.data && !rules.data.length && (
          <Card>
            <Empty title="No automation rules yet">For example: when AI says a new email is a sales enquiry, set it to high priority, assign it to the sales team and prepare a reply draft.</Empty>
          </Card>
        )}
        {rules.data?.map((r) => (
          <Card key={r.id} className="p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  {r.name} <Badge tone={r.isEnabled ? 'success' : 'neutral'}>{r.isEnabled ? 'on' : 'off'}</Badge> {r.department && <Badge>{r.department.name}</Badge>}
                </p>
                <p className="text-[13px] text-text-2">
                  When: {TRIGGER[r.trigger]?.label ?? r.trigger}
                  {r.conditions.conditions.length > 0 && ` · if ${r.conditions.conditions.map((c) => `${FIELD[c.field]} ${OPS[c.op]} “${c.field === 'mailbox' ? (mailboxes.data?.find((m) => m.id === c.value)?.emailAddress ?? c.value) : c.value}”`).join(r.conditions.match === 'all' ? ' and ' : ' or ')}`}
                </p>
                <p className="text-[13px] text-text-2">Then: {r.actions.map(describeAction).join(' → ')}</p>
                <p className="text-[12px] text-text-3">
                  {r.runCount} run{r.runCount === 1 ? '' : 's'}
                  {r.lastRun ? ` · last ${shortDate(r.lastRun.startedAt)} (${r.lastRun.status.toLowerCase()})` : ''}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => void toggle(r)}>
                  {r.isEnabled ? 'Turn off' : 'Turn on'}
                </Button>
                {r.trigger !== 'USER_ABSENT' && (
                  <Button size="sm" onClick={() => setTestFor(r)}>
                    Test
                  </Button>
                )}
                <Button size="sm" onClick={() => setRunsFor(r)}>
                  Run log
                </Button>
                <Button size="sm" onClick={() => (setError(null), edit(r))}>
                  Edit
                </Button>
                <Button size="sm" variant="danger" onClick={() => void remove(r)}>
                  Delete
                </Button>
              </div>
            </div>
          </Card>
        ))}
      </div>

      {form && (
        <Modal
          open
          wide
          onClose={() => setForm(null)}
          title={form.id ? 'Edit automation rule' : 'New automation rule'}
          footer={
            <>
              <Button onClick={() => setForm(null)}>Cancel</Button>
              <Button variant="primary" pending={saving} onClick={() => void save()} disabled={!form.name.trim()}>
                Save
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4 text-[13.5px]">
            {error && <ErrorBanner error={{ message: Object.keys(fe).length ? `${error.message}: ${Object.values(fe).join(' ')}` : error.message }} />}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name" htmlFor="a-name">
                <Input id="a-name" value={form.name} maxLength={120} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </Field>
              <Field label="Applies to" htmlFor="a-dept" hint={isAll ? 'Empty: every department.' : 'Your department.'}>
                <Select id="a-dept" value={form.departmentId} onChange={(e) => setForm({ ...form, departmentId: e.target.value })}>
                  {isAll && <option value="">Whole company</option>}
                  {depts.data?.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label="When" htmlFor="a-trigger" hint={TRIGGER[form.trigger]?.hint}>
              <Select
                id="a-trigger"
                value={form.trigger}
                onChange={(e) => {
                  const trigger = e.target.value;
                  setForm({ ...form, trigger, conditions: trigger === 'USER_ABSENT' ? [] : form.conditions, actions: trigger === 'USER_ABSENT' ? [defaults.reassign_absent!] : form.actions.filter((a) => a.type !== 'reassign_absent').length ? form.actions.filter((a) => a.type !== 'reassign_absent') : [defaults.set_priority!] });
                }}
              >
                {Object.entries(TRIGGER).map(([k, v]) => (
                  <option key={k} value={k} disabled={k === 'LEAD_DETECTED' && !ai?.enabled}>
                    {v.label}
                  </option>
                ))}
              </Select>
            </Field>

            {form.trigger !== 'USER_ABSENT' && (
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 font-medium">
                  If{' '}
                  <select aria-label="Match" className="rounded border border-border bg-surface px-1" value={form.match} onChange={(e) => setForm({ ...form, match: e.target.value as 'all' | 'any' })}>
                    <option value="all">all</option>
                    <option value="any">any</option>
                  </select>{' '}
                  of these are true (none = always)
                </legend>
                {form.conditions.map((c, i) => (
                  <div key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.4fr)_auto] gap-2">
                    <Select aria-label="Field" className="h-8 text-[13px]" value={c.field} onChange={(e) => setCond(i, { field: e.target.value, value: '' })}>
                      {Object.entries(FIELD).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v}
                        </option>
                      ))}
                    </Select>
                    <Select aria-label="Operator" className="h-8 text-[13px]" value={c.op} onChange={(e) => setCond(i, { op: e.target.value })}>
                      {Object.entries(OPS).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v}
                        </option>
                      ))}
                    </Select>
                    {valueInput(c, i)}
                    <Button size="sm" variant="ghost" aria-label="Remove condition" onClick={() => setForm({ ...form, conditions: form.conditions.filter((_, k) => k !== i) })}>
                      ✕
                    </Button>
                  </div>
                ))}
                <Button size="sm" className="self-start" onClick={() => setForm({ ...form, conditions: [...form.conditions, { field: 'subject', op: 'contains', value: '' }] })}>
                  + Condition
                </Button>
              </fieldset>
            )}

            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 font-medium">Then, in this order</legend>
              {form.actions.map((a, i) => (
                <div key={i} className="flex flex-col gap-2 rounded-md border border-border p-2">
                  <div className="flex gap-2">
                    <Select aria-label="Action" className="h-8 flex-1 text-[13px]" value={a.type} onChange={(e) => setForm({ ...form, actions: form.actions.map((x, k) => (k === i ? { ...defaults[e.target.value]! } : x)) })}>
                      {actionTypes.map((t) => (
                        <option key={t} value={t}>
                          {ACTION[t]}
                        </option>
                      ))}
                    </Select>
                    <Button size="sm" variant="ghost" aria-label="Remove action" disabled={form.actions.length === 1} onClick={() => setForm({ ...form, actions: form.actions.filter((_, k) => k !== i) })}>
                      ✕
                    </Button>
                  </div>
                  {a.type === 'assign' && (
                    <div className="grid gap-2 sm:grid-cols-3">
                      <Select aria-label="Assign to" className="h-8 text-[13px]" value={String(a.targetType)} onChange={(e) => setAction(i, { targetType: e.target.value, strategy: e.target.value === 'USER' ? 'DIRECT' : 'ROUND_ROBIN' })}>
                        <option value="TEAM">Team</option>
                        <option value="DEPARTMENT">Department</option>
                        <option value="USER">Person</option>
                      </Select>
                      {a.targetType === 'USER' && userSelect(a.targetUserId, (v) => setAction(i, { targetUserId: v }))}
                      {a.targetType === 'TEAM' && (
                        <Select aria-label="Team" className="h-8 text-[13px]" value={String(a.teamId ?? '')} onChange={(e) => setAction(i, { teamId: e.target.value })}>
                          <option value="">Choose…</option>
                          {teams.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name}
                            </option>
                          ))}
                        </Select>
                      )}
                      {a.targetType === 'DEPARTMENT' && (
                        <Select aria-label="Department" className="h-8 text-[13px]" value={String(a.departmentId ?? '')} onChange={(e) => setAction(i, { departmentId: e.target.value })}>
                          <option value="">Choose…</option>
                          {depts.data?.map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.name}
                            </option>
                          ))}
                        </Select>
                      )}
                      {a.targetType !== 'USER' && (
                        <Select aria-label="How" className="h-8 text-[13px]" value={String(a.strategy)} onChange={(e) => setAction(i, { strategy: e.target.value })}>
                          <option value="ROUND_ROBIN">Round-robin</option>
                          <option value="LEAST_LOADED">Least loaded</option>
                          <option value="DIRECT">Queue only</option>
                        </Select>
                      )}
                    </div>
                  )}
                  {a.type === 'set_priority' && (
                    <Select aria-label="Priority" className="h-8 text-[13px]" value={String(a.priority)} onChange={(e) => setAction(i, { priority: e.target.value })}>
                      {PRIORITIES.map((p) => (
                        <option key={p} value={p}>
                          {p.toLowerCase()}
                        </option>
                      ))}
                    </Select>
                  )}
                  {a.type === 'set_status' && (
                    <Select aria-label="Status" className="h-8 text-[13px]" value={String(a.status)} onChange={(e) => setAction(i, { status: e.target.value })}>
                      {AUTOMATION_STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {STATUS_LABEL[s] ?? s}
                        </option>
                      ))}
                    </Select>
                  )}
                  {a.type === 'add_tag' && (
                    <Select aria-label="Tag" className="h-8 text-[13px]" value={String(a.tagId ?? '')} onChange={(e) => setAction(i, { tagId: e.target.value })}>
                      <option value="">Choose…</option>
                      {tags.data?.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </Select>
                  )}
                  {a.type === 'notify' && (
                    <div className="grid gap-2 sm:grid-cols-2">
                      <Select aria-label="Who" className="h-8 text-[13px]" value={String(a.to)} onChange={(e) => setAction(i, { to: e.target.value })}>
                        {form.trigger !== 'USER_ABSENT' && <option value="assignee">The assignee</option>}
                        {form.trigger !== 'USER_ABSENT' && <option value="team_leader">The team leader</option>}
                        <option value="department_manager">The department manager</option>
                        <option value="users">Chosen people</option>
                      </Select>
                      {a.to === 'users' && userSelect((a.userIds as string[])[0], (v) => setAction(i, { userIds: v ? [v] : [] }), 'Person')}
                      <Input aria-label="Message" className="h-8 text-[13px] sm:col-span-2" placeholder="Message shown in the bell" value={String(a.message ?? '')} maxLength={300} onChange={(e) => setAction(i, { message: e.target.value })} />
                    </div>
                  )}
                  {a.type === 'create_task' && (
                    <div className="grid gap-2 sm:grid-cols-3">
                      <Input aria-label="Task" className="h-8 text-[13px] sm:col-span-3" placeholder="Task title" value={String(a.title ?? '')} maxLength={300} onChange={(e) => setAction(i, { title: e.target.value })} />
                      <label className="flex items-center gap-1 text-[12.5px] text-text-2">
                        Due in <Input aria-label="Due in hours" type="number" min={0} className="h-8 w-20 text-[13px]" value={String(a.dueInHours ?? 24)} onChange={(e) => setAction(i, { dueInHours: Number(e.target.value) })} /> h
                      </label>
                      <Select aria-label="For" className="h-8 text-[13px]" value={String(a.assignTo)} onChange={(e) => setAction(i, { assignTo: e.target.value })}>
                        <option value="assignee">For the assignee</option>
                        <option value="user">For a person</option>
                      </Select>
                      {a.assignTo === 'user' && userSelect(a.userId, (v) => setAction(i, { userId: v }))}
                    </div>
                  )}
                  {a.type === 'create_lead' && <Input aria-label="Service interest" className="h-8 text-[13px]" placeholder="Service interest (optional), e.g. SEO" value={String(a.serviceInterest ?? '')} maxLength={80} onChange={(e) => setAction(i, { serviceInterest: e.target.value })} />}
                  {a.type === 'request_ai_draft' && (
                    <div className="grid gap-2 sm:grid-cols-[160px_minmax(0,1fr)]">
                      <Select aria-label="Tone" className="h-8 text-[13px]" value={String(a.tone)} onChange={(e) => setAction(i, { tone: e.target.value })}>
                        {AI_TONES.map((t) => (
                          <option key={t} value={t}>
                            {AI_TONE_LABEL[t]}
                          </option>
                        ))}
                      </Select>
                      <Input aria-label="Instructions" className="h-8 text-[13px]" placeholder="Instructions (optional)" value={String(a.instructions ?? '')} maxLength={500} onChange={(e) => setAction(i, { instructions: e.target.value })} />
                      <p className="text-[12px] text-text-3 sm:col-span-2">The draft is saved for the assignee, who is notified. It is never sent until they review it and press Send.</p>
                    </div>
                  )}
                  {a.type === 'reassign_absent' && (
                    <div className="grid gap-2 sm:grid-cols-2">
                      <Select aria-label="To" className="h-8 text-[13px]" value={String(a.to)} onChange={(e) => setAction(i, { to: e.target.value })}>
                        <option value="pool">Their team (round-robin, skipping people who are away)</option>
                        <option value="user">A chosen person</option>
                      </Select>
                      {a.to === 'user' && userSelect(a.userId, (v) => setAction(i, { userId: v }))}
                    </div>
                  )}
                </div>
              ))}
              {form.actions.length < 10 && (
                <Button size="sm" className="self-start" onClick={() => setForm({ ...form, actions: [...form.actions, { ...defaults[actionTypes[0]!]! }] })}>
                  + Action
                </Button>
              )}
            </fieldset>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={form.isEnabled} onChange={(e) => setForm({ ...form, isEnabled: e.target.checked })} /> Rule is on
            </label>
          </div>
        </Modal>
      )}
      {runsFor && <RunsModal rule={runsFor} onClose={() => setRunsFor(null)} />}
      {testFor && <TestModal rule={testFor} onClose={() => setTestFor(null)} />}
    </>
  );
}

function RunsModal({ rule, onClose }: { rule: AutomationRuleView; onClose: () => void }) {
  const runs = useLoad(() => api<AutomationRunView[]>(`/automation-rules/${rule.id}/runs`), [rule.id]);
  return (
    <Modal open wide onClose={onClose} title={`Run log: ${rule.name}`}>
      <ErrorBanner error={runs.error} />
      {runs.data && !runs.data.length && <p className="text-text-3">This rule has not run yet.</p>}
      <ul className="flex flex-col divide-y divide-border text-[13px]">
        {runs.data?.map((r) => (
          <li key={r.id} className="py-2">
            <p className="flex flex-wrap items-center gap-2">
              <Badge tone={r.status === 'SUCCEEDED' ? 'success' : r.status === 'FAILED' ? 'danger' : 'neutral'}>{r.status.toLowerCase()}</Badge>
              {shortDate(r.startedAt)}
              {r.thread && (
                <Link href={`/inbox?thread=${r.thread.id}`} className="truncate underline">
                  {r.thread.subject}
                </Link>
              )}
            </p>
            <ul className="mt-1 pl-4 text-text-2">
              {r.output.map((o, i) => (
                <li key={i} className={o.ok ? '' : 'text-danger'}>
                  {ACTION[o.type] ?? o.type}: {o.detail}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

function TestModal({ rule, onClose }: { rule: AutomationRuleView; onClose: () => void }) {
  const threads = useLoad(() => api<{ items: ThreadListItem[] }>('/threads', { query: { view: 'inbox', limit: 30 } }), []);
  const [threadId, setThreadId] = useState('');
  const [result, setResult] = useState<AutomationTestResult | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const run = async (id: string) => {
    setThreadId(id);
    setResult(null);
    setError(null);
    if (!id) return;
    try {
      setResult(await api<AutomationTestResult>(`/automation-rules/${rule.id}/test`, { method: 'POST', body: { threadId: id } }));
    } catch (e) {
      setError(e as ApiError);
    }
  };
  return (
    <Modal open wide onClose={onClose} title={`Test: ${rule.name}`}>
      <div className="flex flex-col gap-3 text-[13.5px]">
        <p className="text-text-2">Shows what the rule would do for a conversation now. Nothing is changed.</p>
        <Select aria-label="Conversation" value={threadId} onChange={(e) => void run(e.target.value)}>
          <option value="">Choose a recent conversation…</option>
          {threads.data?.items.map((t) => (
            <option key={t.id} value={t.id}>
              {t.subject} — {t.from?.address ?? ''}
            </option>
          ))}
        </Select>
        <ErrorBanner error={error} />
        {result && (
          <div className="rounded-md border border-border p-3">
            <p className="font-medium">{result.matched ? 'The rule applies.' : `The rule does not apply: ${result.reason}`}</p>
            {result.matched && (
              <ol className="mt-1 list-decimal pl-5 text-text-2">
                {result.actions.map((a, i) => (
                  <li key={i}>{a.detail}</li>
                ))}
              </ol>
            )}
            <details className="mt-2 text-[12.5px] text-text-3">
              <summary>Facts checked</summary>
              <dl className="mt-1 grid grid-cols-[130px_minmax(0,1fr)] gap-x-2">
                {Object.entries(result.facts).map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt>{FIELD[k] ?? k}</dt>
                    <dd className="truncate">{v || '—'}</dd>
                  </div>
                ))}
              </dl>
            </details>
          </div>
        )}
      </div>
    </Modal>
  );
}
