'use client';

import { useCallback, useMemo, useState, type FormEvent } from 'react';
import { PERMISSIONS, SCOPES, type DepartmentDetail, type Page, type PermissionKey, type RoleDetail, type UserSummary } from '@crm/shared';
import { api } from '@/lib/api';
import { useAction, useLoad } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { Badge, Button, Card, Empty, ErrorBanner, Field, Input, Modal, PageHeader, Select, Table, Td, formatDate } from '@/components/ui';

const STATUS_TONE = { ACTIVE: 'success', INVITED: 'accent', SUSPENDED: 'danger', DEACTIVATED: 'neutral' } as const;
const TIMEZONES = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : ['UTC'];

export default function UsersPage() {
  const { can, me } = useSession();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [rows, setRows] = useState<UserSummary[]>([]);
  const [editing, setEditing] = useState<UserSummary | 'new' | null>(null);
  const [overridesFor, setOverridesFor] = useState<UserSummary | null>(null);

  const canManage = can('user.manage');
  const departments = useLoad(() => api<DepartmentDetail[]>('/departments'), []);
  const roles = useLoad(() => (canManage || can('role.manage') ? api<RoleDetail[]>('/roles') : Promise.resolve([] as RoleDetail[])), [canManage]);

  const list = useLoad(async () => {
    const page = await api<Page<UserSummary>>('/users', { query: { q, status, departmentId, roleId: roleFilter, limit: 50 } });
    setRows(page.items);
    setCursor(page.nextCursor);
    return page;
  }, [q, status, departmentId, roleFilter]);

  const more = useAction(async () => {
    if (!cursor) return;
    const page = await api<Page<UserSummary>>('/users', { query: { q, status, departmentId, roleId: roleFilter, limit: 50, cursor } });
    setRows((r) => [...r, ...page.items]);
    setCursor(page.nextCursor);
  });

  const replace = useCallback((u: UserSummary) => setRows((r) => (r.some((x) => x.id === u.id) ? r.map((x) => (x.id === u.id ? u : x)) : [u, ...r])), []);

  return (
    <>
      <PageHeader
        title="Employees"
        description="Everyone who can sign in to the CRM."
        actions={canManage && <Button variant="primary" onClick={() => setEditing('new')}>Invite employee</Button>}
      />
      <Card>
        <div className="flex flex-wrap gap-2 border-b border-border p-3">
          <Input placeholder="Search name or email…" value={q} onChange={(e) => setQ(e.target.value)} className="w-full sm:w-64" aria-label="Search employees" />
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto" aria-label="Filter by status">
            <option value="">All statuses</option>
            <option value="ACTIVE">Active</option>
            <option value="INVITED">Invited</option>
            <option value="SUSPENDED">Suspended</option>
          </Select>
          <Select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} className="w-auto" aria-label="Filter by department">
            <option value="">All departments</option>
            {departments.data?.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
          {!!roles.data?.length && (
            <Select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} className="w-auto" aria-label="Filter by role">
              <option value="">All roles</option>
              {roles.data.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          )}
        </div>
        <ErrorBanner error={list.error} />
        {list.loading && !rows.length ? (
          <p className="p-6 text-text-3">Loading…</p>
        ) : !rows.length ? (
          <Empty title="No employees match">Try clearing the filters.</Empty>
        ) : (
          <Table head={['Name', 'Role', 'Department', 'Status', 'Sign-in', 'Last sign-in', '']}>
            {rows.map((u) => (
              <tr key={u.id} className="hover:bg-surface-2/60">
                <Td>
                  <p className="font-medium">{u.name}</p>
                  <p className="text-[12.5px] text-text-3">{u.email}</p>
                </Td>
                <Td>{u.role.name}</Td>
                <Td className="text-text-2">{u.department?.name ?? '—'}</Td>
                <Td>
                  <div className="flex gap-1">
                    <Badge tone={STATUS_TONE[u.status]}>{u.status.toLowerCase()}</Badge>
                    {u.isAbsent && <Badge tone="warning">away</Badge>}
                  </div>
                </Td>
                <Td className="text-[12.5px] text-text-2">
                  {[u.hasPassword && 'password', u.mfaEnabled && '2FA'].filter(Boolean).join(' · ') || 'SSO only'}
                </Td>
                <Td className="text-[12.5px] whitespace-nowrap text-text-2">{formatDate(u.lastLoginAt)}</Td>
                <Td className="text-right whitespace-nowrap">
                  {canManage && (
                    <Button size="sm" variant="ghost" onClick={() => setEditing(u)}>
                      Edit
                    </Button>
                  )}
                  {can('role.manage') && u.id !== me.user.id && (
                    <Button size="sm" variant="ghost" onClick={() => setOverridesFor(u)}>
                      Overrides
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
        {cursor && (
          <div className="border-t border-border p-3 text-center">
            <Button size="sm" onClick={() => void more.run()} pending={more.pending}>
              Load more
            </Button>
          </div>
        )}
      </Card>

      {editing && (
        <UserModal
          user={editing === 'new' ? null : editing}
          roles={roles.data ?? []}
          departments={departments.data ?? []}
          selfId={me.user.id}
          onClose={() => setEditing(null)}
          onSaved={(u) => {
            replace(u);
            setEditing(u);
          }}
        />
      )}
      {overridesFor && <OverridesModal user={overridesFor} onClose={() => setOverridesFor(null)} />}
    </>
  );
}

function UserModal({
  user,
  roles,
  departments,
  selfId,
  onClose,
  onSaved,
}: {
  user: UserSummary | null;
  roles: RoleDetail[];
  departments: DepartmentDetail[];
  selfId: string;
  onClose: () => void;
  onSaved: (u: UserSummary) => void;
}) {
  const [form, setForm] = useState({
    email: user?.email ?? '',
    name: user?.name ?? '',
    roleId: user?.role.id ?? roles.find((r) => r.key === 'EMPLOYEE')?.id ?? '',
    departmentId: user?.department?.id ?? '',
    managerId: user?.manager?.id ?? '',
    timezone: user?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const managers = useLoad(() => api<Page<UserSummary>>('/users', { query: { status: 'ACTIVE', limit: 100 } }), []);

  const save = useAction(async (e: FormEvent) => {
    e.preventDefault();
    const body = {
      name: form.name,
      roleId: form.roleId,
      departmentId: form.departmentId || null,
      managerId: form.managerId || null,
      timezone: form.timezone,
    };
    const saved = user
      ? await api<UserSummary>(`/users/${user.id}`, { method: 'PATCH', body })
      : await api<UserSummary>('/users', { method: 'POST', body: { ...body, email: form.email } });
    onSaved(saved);
    if (!user) onClose();
  });
  const act = useAction(async (path: string) => onSaved(await api<UserSummary>(`/users/${user!.id}/${path}`, { method: 'POST' })));
  const makeLink = useAction(async () => setLink(await api<{ url: string; expiresAt: string }>(`/users/${user!.id}/password-link`, { method: 'POST' })));
  const resetMfa = useAction(async () => {
    if (!confirm(`Reset two-factor authentication for ${user!.name}? They will be signed out everywhere.`)) return;
    await api(`/users/${user!.id}/mfa/reset`, { method: 'POST' });
    onSaved({ ...user!, mfaEnabled: false });
  });

  const fe = save.error?.fieldErrors() ?? {};
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const anyError = save.error && !Object.keys(fe).length ? save.error : (act.error ?? makeLink.error ?? resetMfa.error);

  return (
    <Modal
      open
      onClose={onClose}
      title={user ? `Edit ${user.name}` : 'Invite employee'}
      wide
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" type="submit" form="user-form" pending={save.pending}>
            {user ? 'Save changes' : 'Send invite'}
          </Button>
        </>
      }
    >
      <form id="user-form" onSubmit={(e) => void save.run(e)} className="grid gap-4 sm:grid-cols-2">
        {anyError && (
          <div className="sm:col-span-2">
            <ErrorBanner error={anyError} />
          </div>
        )}
        <Field label="Email" htmlFor="u-email" error={fe.email} hint={user ? undefined : 'Company address, Gmail or a personal Outlook/Hotmail/Live address. They sign in with it (Google/Microsoft or a password link).'}>
          <Input id="u-email" type="email" required disabled={!!user} value={form.email} onChange={set('email')} invalid={!!fe.email} />
        </Field>
        <Field label="Full name" htmlFor="u-name" error={fe.name}>
          <Input id="u-name" required value={form.name} onChange={set('name')} invalid={!!fe.name} />
        </Field>
        <Field label="Role" htmlFor="u-role" error={fe.roleId} hint={user && user.role.id !== form.roleId ? 'Changing the role signs them out everywhere.' : undefined}>
          <Select id="u-role" required value={form.roleId} onChange={set('roleId')}>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Department" htmlFor="u-dept" error={fe.departmentId}>
          <Select id="u-dept" value={form.departmentId} onChange={set('departmentId')}>
            <option value="">No department</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Manager" htmlFor="u-mgr" error={fe.managerId}>
          <Select id="u-mgr" value={form.managerId} onChange={set('managerId')}>
            <option value="">No manager</option>
            {managers.data?.items
              .filter((m) => m.id !== user?.id)
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
          </Select>
        </Field>
        <Field label="Time zone" htmlFor="u-tz" error={fe.timezone}>
          <Select id="u-tz" value={form.timezone} onChange={set('timezone')}>
            {!TIMEZONES.includes(form.timezone) && <option value={form.timezone}>{form.timezone}</option>}
            {TIMEZONES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </Field>
      </form>

      {user && (
        <div className="mt-6 border-t border-border pt-4">
          <p className="mb-2 text-[13px] font-medium">Account</p>
          <div className="flex flex-wrap gap-2">
            {user.status === 'SUSPENDED' ? (
              <Button size="sm" onClick={() => void act.run('reactivate')} pending={act.pending}>
                Reactivate
              </Button>
            ) : (
              user.id !== selfId && (
                <Button
                  size="sm"
                  variant="danger"
                  pending={act.pending}
                  onClick={() => confirm(`Suspend ${user.name}? They will be signed out immediately.`) && void act.run('suspend')}
                >
                  Suspend
                </Button>
              )
            )}
            {user.status !== 'SUSPENDED' && (
              <Button size="sm" onClick={() => void makeLink.run()} pending={makeLink.pending}>
                {user.hasPassword ? 'Create password-reset link' : 'Create set-password link'}
              </Button>
            )}
            {user.mfaEnabled && (
              <Button size="sm" onClick={() => void resetMfa.run()} pending={resetMfa.pending}>
                Reset 2FA
              </Button>
            )}
          </div>
          {link && (
            <div className="mt-3 rounded-md border border-border bg-surface-2 p-3 text-[13px]">
              <p className="text-text-2">
                Share this one-time link with {user.name} through a trusted channel. It expires {formatDate(link.expiresAt)} and stops working once used.
              </p>
              <div className="mt-2 flex gap-2">
                <Input readOnly value={link.url} onFocus={(e) => e.target.select()} aria-label="Password link" />
                <Button size="md" onClick={() => void navigator.clipboard.writeText(link.url)}>
                  Copy
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

type OverrideRow = { permissionKey: PermissionKey; effect: 'GRANT' | 'DENY'; scope: string | null; reason?: string | null; expiresAt?: string | null };

function OverridesModal({ user, onClose }: { user: UserSummary; onClose: () => void }) {
  const loaded = useLoad(() => api<OverrideRow[]>(`/users/${user.id}/permission-overrides`), [user.id]);
  const [rows, setRows] = useState<OverrideRow[] | null>(null);
  const current = rows ?? loaded.data ?? [];
  const keys = useMemo(() => Object.keys(PERMISSIONS) as PermissionKey[], []);
  const [saved, setSaved] = useState(false);

  const save = useAction(async () => {
    await api(`/users/${user.id}/permission-overrides`, {
      method: 'PUT',
      body: {
        overrides: current.map((r) => ({
          permissionKey: r.permissionKey,
          effect: r.effect,
          scope: r.effect === 'GRANT' ? r.scope : null,
          reason: r.reason || undefined,
          expiresAt: r.expiresAt || null,
        })),
      },
    });
    setSaved(true);
  });

  const update = (i: number, patch: Partial<OverrideRow>) => {
    setSaved(false);
    setRows(current.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };
  const unused = keys.filter((k) => !current.some((r) => r.permissionKey === k));

  return (
    <Modal
      open
      onClose={onClose}
      wide
      title={`Permission overrides — ${user.name}`}
      footer={
        <>
          {saved && <span className="mr-auto self-center text-[13px] text-success">Saved</span>}
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" onClick={() => void save.run()} pending={save.pending}>
            Save overrides
          </Button>
        </>
      }
    >
      <p className="mb-3 text-[13px] text-text-2">
        Exceptions to the <strong>{user.role.name}</strong> role. A deny always wins. You cannot grant more than you have yourself.
      </p>
      <ErrorBanner error={save.error ?? loaded.error} />
      {current.length === 0 && <p className="py-3 text-text-3">No overrides — this employee has exactly their role’s permissions.</p>}
      <div className="flex flex-col gap-2">
        {current.map((r, i) => (
          <div key={r.permissionKey} className="grid grid-cols-1 items-center gap-2 rounded-md border border-border p-2 sm:grid-cols-[1fr_100px_130px_auto]">
            <div>
              <p className="font-mono text-[12.5px]">{r.permissionKey}</p>
              <p className="text-[12px] text-text-3">{PERMISSIONS[r.permissionKey]}</p>
            </div>
            <Select value={r.effect} onChange={(e) => update(i, { effect: e.target.value as 'GRANT' | 'DENY' })} aria-label="Effect">
              <option value="GRANT">Grant</option>
              <option value="DENY">Deny</option>
            </Select>
            <Select value={r.scope ?? ''} disabled={r.effect === 'DENY'} onChange={(e) => update(i, { scope: e.target.value || null })} aria-label="Scope">
              <option value="">Role default</option>
              {SCOPES.map((s) => (
                <option key={s} value={s}>
                  {s.toLowerCase()}
                </option>
              ))}
            </Select>
            <Button size="sm" variant="ghost" onClick={() => setRows(current.filter((_, j) => j !== i))} aria-label={`Remove ${r.permissionKey}`}>
              Remove
            </Button>
          </div>
        ))}
      </div>
      {unused.length > 0 && (
        <div className="mt-3">
          <Select
            value=""
            onChange={(e) => {
              if (!e.target.value) return;
              setSaved(false);
              setRows([...current, { permissionKey: e.target.value as PermissionKey, effect: 'GRANT', scope: null }]);
            }}
            aria-label="Add override"
          >
            <option value="">+ Add an override…</option>
            {unused.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </Select>
        </div>
      )}
    </Modal>
  );
}

