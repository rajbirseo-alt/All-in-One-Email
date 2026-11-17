'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { SCOPES, type RoleDetail } from '@crm/shared';
import { api } from '@/lib/api';
import { useAction, useLoad } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { Badge, Button, Card, ErrorBanner, Field, Input, Modal, PageHeader, Select } from '@/components/ui';

interface CatalogueEntry {
  key: string;
  description: string;
  global: boolean;
}

const SCOPE_HELP: Record<string, string> = {
  OWN: 'own records',
  ASSIGNED: 'assigned / shared',
  TEAM: 'their teams',
  DEPARTMENT: 'their department',
  ALL: 'company-wide',
};

export default function RolesPage() {
  const { me } = useSession();
  const roles = useLoad(() => api<RoleDetail[]>('/roles'), []);
  const catalogue = useLoad(() => api<CatalogueEntry[]>('/permissions'), []);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const selected = roles.data?.find((r) => r.id === selectedId) ?? roles.data?.[0];

  return (
    <>
      <PageHeader
        title="Roles & permissions"
        description="What each role can do, and how widely. Changes apply on each member’s next request."
        actions={<Button variant="primary" onClick={() => setCreating(true)}>New role</Button>}
      />
      <ErrorBanner error={roles.error ?? catalogue.error} />
      <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
        <Card className="h-fit">
          <ul className="p-1.5">
            {roles.data?.map((r) => (
              <li key={r.id}>
                <button
                  onClick={() => setSelectedId(r.id)}
                  aria-current={selected?.id === r.id || undefined}
                  className={`flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left ${selected?.id === r.id ? 'bg-accent-soft text-accent' : 'hover:bg-surface-2'}`}
                >
                  <span className="font-medium">{r.name}</span>
                  <span className="text-[12px] text-text-3">{r.userCount}</span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
        {selected && catalogue.data && (
          <RoleEditor key={selected.id + (selected.permissions.length ?? 0)} role={selected} catalogue={catalogue.data} isOwnRole={selected.id === me.user.role.id} onChanged={roles.reload} onDeleted={() => { setSelectedId(null); void roles.reload(); }} />
        )}
      </div>
      {creating && (
        <CreateRoleModal
          onClose={() => setCreating(false)}
          onCreated={async (id) => {
            setCreating(false);
            await roles.reload();
            setSelectedId(id);
          }}
        />
      )}
    </>
  );
}

function RoleEditor({ role, catalogue, isOwnRole, onChanged, onDeleted }: { role: RoleDetail; catalogue: CatalogueEntry[]; isOwnRole: boolean; onChanged: () => Promise<void>; onDeleted: () => void }) {
  const initial = Object.fromEntries(role.permissions.map((p) => [p.permissionKey, p.scope]));
  const [matrix, setMatrix] = useState<Record<string, string>>(initial);
  const [saved, setSaved] = useState(false);
  useEffect(() => setSaved(false), [matrix]);
  const locked = role.key === 'SUPER_ADMIN' || isOwnRole;
  const dirty = JSON.stringify(Object.entries(matrix).sort()) !== JSON.stringify(Object.entries(initial).sort());

  const save = useAction(async () => {
    await api(`/roles/${role.id}/permissions`, {
      method: 'PUT',
      body: { permissions: Object.entries(matrix).map(([permissionKey, scope]) => ({ permissionKey, scope })) },
    });
    await onChanged();
    setSaved(true);
  });
  const remove = useAction(async () => {
    if (!confirm(`Delete the role “${role.name}”?`)) return;
    await api(`/roles/${role.id}`, { method: 'DELETE' });
    onDeleted();
  });

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border p-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-[16px] font-semibold">{role.name}</h2>
            {role.isSystem && <Badge>system</Badge>}
          </div>
          {role.description && <p className="mt-0.5 text-text-2">{role.description}</p>}
          {role.key === 'SUPER_ADMIN' && <p className="mt-1 text-[13px] text-text-3">Super Admin always has complete access.</p>}
          {isOwnRole && role.key !== 'SUPER_ADMIN' && <p className="mt-1 text-[13px] text-text-3">You can’t change the permissions of your own role.</p>}
        </div>
        <div className="flex gap-2">
          {!role.isSystem && (
            <Button variant="danger" onClick={() => void remove.run()} pending={remove.pending} disabled={role.userCount > 0} title={role.userCount > 0 ? 'Move its employees to another role first' : undefined}>
              Delete role
            </Button>
          )}
          {!locked && (
            <Button variant="primary" onClick={() => void save.run()} pending={save.pending} disabled={!dirty}>
              {saved && !dirty ? 'Saved' : 'Save permissions'}
            </Button>
          )}
        </div>
      </div>
      <div className="p-4">
        <ErrorBanner error={save.error ?? remove.error} />
      </div>
      <ul className="-mt-4">
        {catalogue.map((p) => (
          <li key={p.key} className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2.5 first:border-t-0">
            <div className="min-w-0">
              <p className="font-mono text-[12.5px]">{p.key}</p>
              <p className="text-[12.5px] text-text-3">{p.description}</p>
            </div>
            <Select
              aria-label={`Scope for ${p.key}`}
              className="w-44"
              disabled={locked}
              value={matrix[p.key] ?? ''}
              onChange={(e) =>
                setMatrix((m) => {
                  const n = { ...m };
                  if (e.target.value) n[p.key] = e.target.value;
                  else delete n[p.key];
                  return n;
                })
              }
            >
              <option value="">No access</option>
              {(p.global ? (['ALL'] as const) : SCOPES).map((s) => (
                <option key={s} value={s}>
                  {p.global ? 'Allowed' : `${s.toLowerCase()} — ${SCOPE_HELP[s]}`}
                </option>
              ))}
            </Select>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function CreateRoleModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [description, setDescription] = useState('');
  const create = useAction(async (e: FormEvent) => {
    e.preventDefault();
    const r = await api<{ id: string }>('/roles', { method: 'POST', body: { name, key, description: description || undefined } });
    onCreated(r.id);
  });
  const fe = create.error?.fieldErrors() ?? {};
  return (
    <Modal
      open
      onClose={onClose}
      title="New role"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="role-form" pending={create.pending}>
            Create role
          </Button>
        </>
      }
    >
      <form id="role-form" onSubmit={(e) => void create.run(e)} className="flex flex-col gap-4">
        {create.error && !Object.keys(fe).length && <ErrorBanner error={create.error} />}
        <Field label="Name" htmlFor="r-name" error={fe.name}>
          <Input
            id="r-name"
            required
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40));
            }}
          />
        </Field>
        <Field label="Key" htmlFor="r-key" error={fe.key} hint="Permanent identifier, e.g. CONTENT_TEAM.">
          <Input id="r-key" required value={key} onChange={(e) => setKey(e.target.value.toUpperCase())} className="font-mono" />
        </Field>
        <Field label="Description" htmlFor="r-desc" error={fe.description}>
          <Input id="r-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <p className="text-[13px] text-text-3">New roles start with no permissions. Set them after creating the role.</p>
      </form>
    </Modal>
  );
}
