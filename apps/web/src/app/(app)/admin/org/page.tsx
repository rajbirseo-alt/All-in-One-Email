'use client';

import { useState, type FormEvent } from 'react';
import type { DepartmentDetail, Page, TeamDetail, UserSummary } from '@crm/shared';
import { api } from '@/lib/api';
import { useAction, useLoad } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { Badge, Button, Card, Empty, ErrorBanner, Field, Input, Modal, PageHeader, Select } from '@/components/ui';

export default function OrgPage() {
  const { can } = useSession();
  const manage = can('org.manage');
  const depts = useLoad(() => api<DepartmentDetail[]>('/departments'), []);
  const people = useLoad(() => api<Page<UserSummary>>('/users', { query: { limit: 100 } }), []);
  const [deptModal, setDeptModal] = useState<DepartmentDetail | 'new' | null>(null);
  const [teamModal, setTeamModal] = useState<{ dept: DepartmentDetail; team: TeamDetail | null } | null>(null);
  const users = people.data?.items ?? [];

  const removeDept = useAction(async (d: DepartmentDetail) => {
    if (!confirm(`Delete department “${d.name}”?`)) return;
    await api(`/departments/${d.id}`, { method: 'DELETE' });
    await depts.reload();
  });

  return (
    <>
      <PageHeader
        title="Departments & teams"
        description="Departments scope what managers see; teams drive team inboxes and round-robin assignment."
        actions={manage && <Button variant="primary" onClick={() => setDeptModal('new')}>New department</Button>}
      />
      <ErrorBanner error={depts.error ?? removeDept.error} />
      {depts.loading && !depts.data ? (
        <p className="text-text-3">Loading…</p>
      ) : !depts.data?.length ? (
        <Card>
          <Empty title="No departments yet">{manage ? 'Create Sales, Finance, HR and so on to start organising employees.' : 'An administrator has not set any up.'}</Empty>
        </Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {depts.data.map((d) => (
            <Card key={d.id}>
              <div className="flex flex-wrap items-start justify-between gap-2 border-b border-border p-4">
                <div>
                  <h2 className="text-[15px] font-semibold">{d.name}</h2>
                  <p className="text-[13px] text-text-2">
                    {d.memberCount} employee{d.memberCount === 1 ? '' : 's'} · Manager: {d.manager?.name ?? 'none'}
                  </p>
                </div>
                {manage && (
                  <div className="flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setDeptModal(d)}>
                      Edit
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setTeamModal({ dept: d, team: null })}>
                      Add team
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void removeDept.run(d)}>
                      Delete
                    </Button>
                  </div>
                )}
              </div>
              {d.teams.length === 0 ? (
                <p className="px-4 py-3 text-[13px] text-text-3">No teams.</p>
              ) : (
                <ul>
                  {d.teams.map((t) => (
                    <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2.5 first:border-t-0">
                      <div>
                        <p className="font-medium">{t.name}</p>
                        <p className="text-[12.5px] text-text-3">
                          Lead: {t.leader?.name ?? 'none'} · {t.members.length} member{t.members.length === 1 ? '' : 's'}
                        </p>
                      </div>
                      {manage && (
                        <Button size="sm" variant="ghost" onClick={() => setTeamModal({ dept: d, team: t })}>
                          Manage
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          ))}
        </div>
      )}
      {deptModal && <DeptModal dept={deptModal === 'new' ? null : deptModal} users={users} onClose={() => setDeptModal(null)} onSaved={async () => { setDeptModal(null); await depts.reload(); }} />}
      {teamModal && <TeamModal dept={teamModal.dept} team={teamModal.team} users={users} onClose={() => setTeamModal(null)} onChanged={depts.reload} />}
    </>
  );
}

function DeptModal({ dept, users, onClose, onSaved }: { dept: DepartmentDetail | null; users: UserSummary[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(dept?.name ?? '');
  const [slug, setSlug] = useState(dept?.slug ?? '');
  const [managerId, setManagerId] = useState(dept?.manager?.id ?? '');
  const save = useAction(async (e: FormEvent) => {
    e.preventDefault();
    const body = { name, slug, managerId: managerId || null };
    await api(dept ? `/departments/${dept.id}` : '/departments', { method: dept ? 'PATCH' : 'POST', body });
    onSaved();
  });
  const fe = save.error?.fieldErrors() ?? {};
  return (
    <Modal
      open
      onClose={onClose}
      title={dept ? `Edit ${dept.name}` : 'New department'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="dept-form" pending={save.pending}>
            Save
          </Button>
        </>
      }
    >
      <form id="dept-form" onSubmit={(e) => void save.run(e)} className="flex flex-col gap-4">
        {save.error && !Object.keys(fe).length && <ErrorBanner error={save.error} />}
        <Field label="Name" htmlFor="d-name" error={fe.name}>
          <Input
            id="d-name"
            required
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (!dept) setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''));
            }}
          />
        </Field>
        <Field label="Short name" htmlFor="d-slug" error={fe.slug} hint="Lowercase, used in links and reports.">
          <Input id="d-slug" required value={slug} onChange={(e) => setSlug(e.target.value)} className="font-mono" />
        </Field>
        <Field label="Manager" htmlFor="d-mgr" error={fe.managerId}>
          <Select id="d-mgr" value={managerId} onChange={(e) => setManagerId(e.target.value)}>
            <option value="">No manager</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </Select>
        </Field>
      </form>
    </Modal>
  );
}

function TeamModal({ dept, team, users, onClose, onChanged }: { dept: DepartmentDetail; team: TeamDetail | null; users: UserSummary[]; onClose: () => void; onChanged: () => Promise<void> }) {
  const [current, setCurrent] = useState<TeamDetail | null>(team);
  const [name, setName] = useState(team?.name ?? '');
  const [leaderId, setLeaderId] = useState(team?.leader?.id ?? '');
  const [addUser, setAddUser] = useState('');

  const save = useAction(async (e: FormEvent) => {
    e.preventDefault();
    const t = current
      ? await api<TeamDetail>(`/teams/${current.id}`, { method: 'PATCH', body: { name, leaderId: leaderId || null } })
      : await api<TeamDetail>('/teams', { method: 'POST', body: { name, departmentId: dept.id, leaderId: leaderId || null } });
    setCurrent(t);
    await onChanged();
  });
  const member = useAction(async (userId: string, inRotation: boolean) => {
    setCurrent(await api<TeamDetail>(`/teams/${current!.id}/members`, { method: 'PUT', body: { userId, inRotation } }));
    setAddUser('');
    await onChanged();
  });
  const removeMember = useAction(async (userId: string) => {
    setCurrent(await api<TeamDetail>(`/teams/${current!.id}/members/${userId}`, { method: 'DELETE' }));
    await onChanged();
  });
  const del = useAction(async () => {
    if (!confirm(`Delete team “${current!.name}”?`)) return;
    await api(`/teams/${current!.id}`, { method: 'DELETE' });
    await onChanged();
    onClose();
  });
  const fe = save.error?.fieldErrors() ?? {};
  const err = (save.error && !Object.keys(fe).length ? save.error : null) ?? member.error ?? removeMember.error ?? del.error;
  const available = users.filter((u) => !current?.members.some((m) => m.userId === u.id));

  return (
    <Modal
      open
      onClose={onClose}
      wide
      title={current ? `${current.name} · ${dept.name}` : `New team in ${dept.name}`}
      footer={
        <>
          {current && (
            <Button variant="danger" className="mr-auto" onClick={() => void del.run()} pending={del.pending}>
              Delete team
            </Button>
          )}
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" type="submit" form="team-form" pending={save.pending}>
            {current ? 'Save' : 'Create team'}
          </Button>
        </>
      }
    >
      <form id="team-form" onSubmit={(e) => void save.run(e)} className="grid gap-4 sm:grid-cols-2">
        {err && (
          <div className="sm:col-span-2">
            <ErrorBanner error={err} />
          </div>
        )}
        <Field label="Team name" htmlFor="t-name" error={fe.name}>
          <Input id="t-name" required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Team leader" htmlFor="t-lead" error={fe.leaderId}>
          <Select id="t-lead" value={leaderId} onChange={(e) => setLeaderId(e.target.value)}>
            <option value="">No leader</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </Select>
        </Field>
      </form>
      {current && (
        <div className="mt-6 border-t border-border pt-4">
          <p className="mb-2 text-[13px] font-medium">Members</p>
          {current.members.length === 0 && <p className="text-[13px] text-text-3">No members yet.</p>}
          <ul className="flex flex-col gap-1.5">
            {current.members.map((m) => (
              <li key={m.userId} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
                <div>
                  <p className="font-medium">{m.name}</p>
                  <p className="text-[12.5px] text-text-3">{m.email}</p>
                </div>
                <div className="flex items-center gap-2">
                  {!m.inRotation && <Badge tone="warning">out of rotation</Badge>}
                  <Button size="sm" variant="ghost" onClick={() => void member.run(m.userId, !m.inRotation)}>
                    {m.inRotation ? 'Pause rotation' : 'Resume rotation'}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void removeMember.run(m.userId)}>
                    Remove
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex gap-2">
            <Select value={addUser} onChange={(e) => setAddUser(e.target.value)} aria-label="Employee to add">
              <option value="">Choose an employee…</option>
              {available.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.email})
                </option>
              ))}
            </Select>
            <Button disabled={!addUser} pending={member.pending} onClick={() => void member.run(addUser, true)}>
              Add
            </Button>
          </div>
          <p className="mt-2 text-[12.5px] text-text-3">“Rotation” controls who receives round-robin assignments (Phase 5).</p>
        </div>
      )}
    </Modal>
  );
}
