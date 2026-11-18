'use client';

import { useState } from 'react';
import type { AssignmentRuleView, DepartmentDetail, MailboxSummary, Page, RuleTestResult, TagView, UserSummary } from '@crm/shared';
import { api } from '@/lib/api';
import { useAction, useLoad } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { Badge, Button, Card, Empty, ErrorBanner, Field, Input, Modal, PageHeader, Select } from '@/components/ui';

const FIELDS = { mailbox: 'Mailbox', from: 'Sender address', fromDomain: 'Sender domain', to: 'Recipient', subject: 'Subject', body: 'Body text' } as const;
const OPS = { is: 'is', contains: 'contains', notContains: 'does not contain', startsWith: 'starts with', endsWith: 'ends with' } as const;
const STRATEGY = { DIRECT: 'Into the queue', ROUND_ROBIN: 'Round-robin', LEAST_LOADED: 'Least busy' } as const;

type Cond = { field: keyof typeof FIELDS; op: keyof typeof OPS; value: string };
type Form = {
  id: string | null;
  name: string;
  isEnabled: boolean;
  match: 'all' | 'any';
  conditions: Cond[];
  targetType: 'USER' | 'TEAM' | 'DEPARTMENT';
  targetUserId: string;
  teamId: string;
  departmentId: string;
  strategy: keyof typeof STRATEGY;
  setPriority: string;
};

const blank: Form = { id: null, name: '', isEnabled: true, match: 'all', conditions: [{ field: 'mailbox', op: 'is', value: '' }], targetType: 'TEAM', targetUserId: '', teamId: '', departmentId: '', strategy: 'ROUND_ROBIN', setPriority: '' };

export default function RulesPage() {
  const { me } = useSession();
  const isAll = me.permissions['rules.manage'] === 'ALL';
  const rules = useLoad(() => api<AssignmentRuleView[]>('/assignment-rules'), []);
  const mailboxes = useLoad(() => api<MailboxSummary[]>('/accounts'), []);
  const depts = useLoad(() => api<DepartmentDetail[]>('/departments'), []);
  const users = useLoad(() => api<Page<UserSummary>>('/users', { query: { limit: 100, status: 'ACTIVE' } }), []);
  const tags = useLoad(() => api<TagView[]>('/tags'), []);
  const [form, setForm] = useState<Form | null>(null);
  const [sample, setSample] = useState({ accountId: '', from: '', subject: '', body: '' });
  const [result, setResult] = useState<RuleTestResult | null>(null);
  const [tagName, setTagName] = useState('');
  const [tagColor, setTagColor] = useState('#2563eb');
  const teams = depts.data?.flatMap((d) => d.teams) ?? [];
  const mailboxName = (id: string) => mailboxes.data?.find((m) => m.id === id)?.emailAddress ?? 'unknown mailbox';

  const save = useAction(async (f: Form) => {
    const body = {
      name: f.name,
      isEnabled: f.isEnabled,
      conditions: { match: f.match, conditions: f.conditions },
      targetType: f.targetType,
      targetUserId: f.targetType === 'USER' ? f.targetUserId : null,
      teamId: f.targetType === 'TEAM' ? f.teamId : null,
      departmentId: f.targetType === 'DEPARTMENT' ? f.departmentId : null,
      strategy: f.targetType === 'USER' ? 'DIRECT' : f.strategy,
      setPriority: f.setPriority || null,
    };
    await api(f.id ? `/assignment-rules/${f.id}` : '/assignment-rules', { method: f.id ? 'PATCH' : 'POST', body });
    setForm(null);
    await rules.reload();
  });
  const act = useAction(async (fn: () => Promise<unknown>) => {
    await fn();
    await Promise.all([rules.reload(), tags.reload()]);
  });
  const test = useAction(async () => setResult(await api<RuleTestResult>('/assignment-rules/test', { method: 'POST', body: { sample } })));

  const move = (i: number, d: -1 | 1) => {
    const ids = rules.data!.map((r) => r.id);
    [ids[i], ids[i + d]] = [ids[i + d]!, ids[i]!];
    void act.run(() => api('/assignment-rules/order', { method: 'PUT', body: { ids } }));
  };
  const edit = (r: AssignmentRuleView) =>
    setForm({
      id: r.id,
      name: r.name,
      isEnabled: r.isEnabled,
      match: r.conditions.match,
      conditions: r.conditions.conditions as Cond[],
      targetType: r.targetType,
      targetUserId: r.targetUser?.id ?? '',
      teamId: r.team?.id ?? '',
      departmentId: r.department?.id ?? '',
      strategy: r.strategy,
      setPriority: r.setPriority ?? '',
    });
  const describe = (c: { field: string; op: string; value: string }) =>
    `${FIELDS[c.field as keyof typeof FIELDS]} ${OPS[c.op as keyof typeof OPS]} “${c.field === 'mailbox' ? mailboxName(c.value) : c.value}”`;

  return (
    <>
      <PageHeader
        title="Routing rules"
        description="New incoming conversations are checked against these rules from top to bottom; the first match decides who gets it. Mail imported when a mailbox is connected is never routed."
        actions={<Button variant="primary" onClick={() => setForm({ ...blank, conditions: [{ field: 'mailbox', op: 'is', value: mailboxes.data?.[0]?.id ?? '' }] })}>New rule</Button>}
      />
      <ErrorBanner error={rules.error ?? act.error} />
      <Card>
        {!rules.data?.length ? (
          <Empty title="No rules yet">Without rules, new conversations stay unassigned in their mailbox.</Empty>
        ) : (
          <ol>
            {rules.data.map((r, i) => (
              <li key={r.id} className="flex flex-wrap items-start justify-between gap-2 border-b border-border px-4 py-3 last:border-0">
                <div className="min-w-0">
                  <p className="font-medium">
                    {i + 1}. {r.name} {!r.isEnabled && <Badge>off</Badge>} {r.setPriority && <Badge tone="warning">{r.setPriority.toLowerCase()} priority</Badge>}
                  </p>
                  <p className="text-[13px] text-text-2">
                    If {r.conditions.match === 'all' ? 'all' : 'any'} of: {r.conditions.conditions.map(describe).join('; ')}
                  </p>
                  <p className="text-[13px] text-text-2">
                    → {r.targetUser?.name ?? r.team?.name ?? r.department?.name} {r.targetType !== 'USER' && `(${STRATEGY[r.strategy].toLowerCase()})`}
                  </p>
                </div>
                <div className="flex gap-1">
                  {isAll && (
                    <>
                      <Button size="sm" variant="ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">
                        ↑
                      </Button>
                      <Button size="sm" variant="ghost" disabled={i === rules.data!.length - 1} onClick={() => move(i, 1)} aria-label="Move down">
                        ↓
                      </Button>
                    </>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => edit(r)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => confirm(`Delete rule “${r.name}”?`) && void act.run(() => api(`/assignment-rules/${r.id}`, { method: 'DELETE' }))}>
                    Delete
                  </Button>
                </div>
              </li>
            ))}
          </ol>
        )}
      </Card>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card className="p-4">
          <h2 className="mb-2 text-[15px] font-semibold">Test the rules</h2>
          <p className="mb-3 text-[13px] text-text-3">Shows which rule a message would match and who would get it. Nothing is assigned.</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <Select aria-label="Mailbox" value={sample.accountId} onChange={(e) => setSample({ ...sample, accountId: e.target.value })}>
              <option value="">Mailbox…</option>
              {mailboxes.data?.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.emailAddress}
                </option>
              ))}
            </Select>
            <Input placeholder="From (client@company.com)" value={sample.from} onChange={(e) => setSample({ ...sample, from: e.target.value })} />
            <Input placeholder="Subject" value={sample.subject} onChange={(e) => setSample({ ...sample, subject: e.target.value })} className="sm:col-span-2" />
          </div>
          <Button className="mt-2" size="sm" disabled={!sample.accountId || !sample.from} pending={test.pending} onClick={() => void test.run()}>
            Test
          </Button>
          <ErrorBanner error={test.error} />
          {result && (
            <div className="mt-3 text-[13.5px]">
              {result.rule ? (
                <p>
                  Matches <b>{result.rule.name}</b> → {result.wouldAssignTo ? <b>{result.wouldAssignTo.name}</b> : <>queue {result.queue.team?.name ?? result.queue.department?.name}</>}
                </p>
              ) : (
                <p>No rule matches; it would stay unassigned.</p>
              )}
            </div>
          )}
        </Card>

        <Card className="p-4">
          <h2 className="mb-2 text-[15px] font-semibold">Tags</h2>
          <div className="mb-3 flex flex-wrap gap-1">
            {tags.data?.map((t) => (
              <span key={t.id} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[12.5px] font-medium text-white" style={{ background: t.color }}>
                {t.name}
                {isAll && (
                  <button aria-label={`Delete ${t.name}`} onClick={() => confirm(`Delete tag “${t.name}” from every conversation?`) && void act.run(() => api(`/tags/${t.id}`, { method: 'DELETE' }))}>
                    ✕
                  </button>
                )}
              </span>
            ))}
            {!tags.data?.length && <p className="text-[13px] text-text-3">No tags yet.</p>}
          </div>
          <div className="flex gap-2">
            <Input placeholder="New tag" value={tagName} onChange={(e) => setTagName(e.target.value)} className="h-8" />
            <input type="color" aria-label="Tag colour" value={tagColor} onChange={(e) => setTagColor(e.target.value)} className="h-8 w-10 rounded border border-border" />
            <Button size="sm" disabled={!tagName.trim()} onClick={() => void act.run(async () => (await api('/tags', { method: 'POST', body: { name: tagName, color: tagColor } }), setTagName('')))}>
              Add
            </Button>
          </div>
        </Card>
      </div>

      {form && (
        <Modal
          open
          wide
          onClose={() => setForm(null)}
          title={form.id ? 'Edit rule' : 'New rule'}
          footer={
            <>
              <Button onClick={() => setForm(null)}>Cancel</Button>
              <Button variant="primary" pending={save.pending} onClick={() => void save.run(form)}>
                Save
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-3">
            <ErrorBanner error={save.error} />
            <Field label="Name" htmlFor="r-name">
              <Input id="r-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Sales enquiries" />
            </Field>
            <div>
              <p className="mb-1 text-[13px] font-medium">
                When{' '}
                <select value={form.match} onChange={(e) => setForm({ ...form, match: e.target.value as Form['match'] })} className="rounded border border-border bg-surface px-1">
                  <option value="all">all</option>
                  <option value="any">any</option>
                </select>{' '}
                of these match:
              </p>
              {form.conditions.map((c, i) => {
                const set = (patch: Partial<Cond>) => setForm({ ...form, conditions: form.conditions.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
                return (
                  <div key={i} className="mb-1 flex flex-wrap gap-1">
                    <Select aria-label="Field" value={c.field} onChange={(e) => set({ field: e.target.value as Cond['field'], op: e.target.value === 'mailbox' ? 'is' : c.op, value: '' })} className="h-8 w-40">
                      {Object.entries(FIELDS).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v}
                        </option>
                      ))}
                    </Select>
                    {c.field !== 'mailbox' && (
                      <Select aria-label="Operator" value={c.op} onChange={(e) => set({ op: e.target.value as Cond['op'] })} className="h-8 w-40">
                        {Object.entries(OPS).map(([k, v]) => (
                          <option key={k} value={k}>
                            {v}
                          </option>
                        ))}
                      </Select>
                    )}
                    {c.field === 'mailbox' ? (
                      <Select aria-label="Mailbox" value={c.value} onChange={(e) => set({ value: e.target.value })} className="h-8 min-w-48 flex-1">
                        <option value="">Choose…</option>
                        {mailboxes.data?.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.emailAddress}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <Input aria-label="Value" value={c.value} onChange={(e) => set({ value: e.target.value })} className="h-8 min-w-40 flex-1" />
                    )}
                    {form.conditions.length > 1 && (
                      <Button size="sm" variant="ghost" onClick={() => setForm({ ...form, conditions: form.conditions.filter((_, j) => j !== i) })}>
                        Remove
                      </Button>
                    )}
                  </div>
                );
              })}
              <Button size="sm" variant="ghost" onClick={() => setForm({ ...form, conditions: [...form.conditions, { field: 'subject', op: 'contains', value: '' }] })}>
                Add condition
              </Button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Send to" htmlFor="r-type">
                <Select id="r-type" value={form.targetType} onChange={(e) => setForm({ ...form, targetType: e.target.value as Form['targetType'] })}>
                  <option value="TEAM">A team</option>
                  <option value="DEPARTMENT">A department</option>
                  <option value="USER">A person</option>
                </Select>
              </Field>
              <Field label={form.targetType === 'USER' ? 'Person' : form.targetType === 'TEAM' ? 'Team' : 'Department'} htmlFor="r-target">
                {form.targetType === 'USER' ? (
                  <Select id="r-target" value={form.targetUserId} onChange={(e) => setForm({ ...form, targetUserId: e.target.value })}>
                    <option value="">Choose…</option>
                    {users.data?.items.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                  </Select>
                ) : form.targetType === 'TEAM' ? (
                  <Select id="r-target" value={form.teamId} onChange={(e) => setForm({ ...form, teamId: e.target.value })}>
                    <option value="">Choose…</option>
                    {teams.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Select id="r-target" value={form.departmentId} onChange={(e) => setForm({ ...form, departmentId: e.target.value })}>
                    <option value="">Choose…</option>
                    {depts.data?.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              {form.targetType !== 'USER' && (
                <Field label="Who gets it" htmlFor="r-strategy" hint="Round-robin and least busy skip people marked away or out of rotation.">
                  <Select id="r-strategy" value={form.strategy} onChange={(e) => setForm({ ...form, strategy: e.target.value as Form['strategy'] })}>
                    {Object.entries(STRATEGY).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              <Field label="Set priority" htmlFor="r-prio">
                <Select id="r-prio" value={form.setPriority} onChange={(e) => setForm({ ...form, setPriority: e.target.value })}>
                  <option value="">Leave as is</option>
                  <option value="LOW">Low</option>
                  <option value="NORMAL">Normal</option>
                  <option value="HIGH">High</option>
                  <option value="URGENT">Urgent</option>
                </Select>
              </Field>
            </div>
            <label className="flex items-center gap-2 text-[14px]">
              <input type="checkbox" checked={form.isEnabled} onChange={(e) => setForm({ ...form, isEnabled: e.target.checked })} /> Rule is on
            </label>
          </div>
        </Modal>
      )}
    </>
  );
}
