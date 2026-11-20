'use client';

import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { DepartmentDetail, MailboxDetail, MailboxProvidersResponse, MailboxStatus, MailboxSummary, Page, UserSummary } from '@crm/shared';
import { api } from '@/lib/api';
import { useAction, useLoad } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { ImapConnectModal } from '@/components/imap-connect';
import { Badge, Button, Card, Empty, ErrorBanner, Field, Input, Modal, PageHeader, Select, Table, Td, formatDate } from '@/components/ui';

const STATUS: Record<MailboxStatus, { label: string; tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' }> = {
  CONNECTING: { label: 'Connecting', tone: 'accent' },
  INITIAL_SYNC: { label: 'Importing', tone: 'accent' },
  ACTIVE: { label: 'Syncing', tone: 'success' },
  NEEDS_REAUTH: { label: 'Reconnect needed', tone: 'danger' },
  ERROR: { label: 'Failing', tone: 'danger' },
  PAUSED: { label: 'Paused', tone: 'warning' },
  DISCONNECTED: { label: 'Disconnected', tone: 'neutral' },
};

const CONNECT_ERRORS: Record<string, string> = {
  cancelled: 'Connecting was cancelled at the provider.',
  invalid_state: 'The connect session expired or was started by someone else. Please try again.',
  token_exchange_failed: 'The provider did not accept the sign-in. Please try again.',
  no_refresh_token: 'The provider did not grant offline access. Remove the app from the account’s third-party access page and connect again.',
  scope_not_granted: 'Mail access was not granted. Tick every permission on the consent screen.',
  connected_with_other_provider: 'This address is already connected through the other provider.',
  provider_error: 'The provider returned an error. Please try again.',
  provider_disabled: 'This provider is not configured on the server.',
  no_mailbox: 'That account has no mailbox.',
};

const PROVIDER_LABEL = { GMAIL: 'Gmail', MICROSOFT: 'Microsoft 365', IMAP: 'IMAP' } as const;

function lag(newest: string | null) {
  if (!newest) return '';
  const mins = Math.round((Date.now() - new Date(newest).getTime()) / 60_000);
  if (mins < 60) return `newest mail ${mins} min ago`;
  if (mins < 48 * 60) return `newest mail ${Math.round(mins / 60)} h ago`;
  return `newest mail ${Math.round(mins / 1440)} d ago`;
}

function MailboxesPage() {
  const { can } = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const canConnect = can('account.connect');
  const canManage = can('account.manage');
  const list = useLoad(() => api<MailboxSummary[]>('/accounts'), []);
  const providers = useLoad(() => (canConnect || canManage ? api<MailboxProvidersResponse>('/accounts/providers') : Promise.resolve(null)), [canConnect, canManage]);
  const [connectFor, setConnectFor] = useState<'google' | 'microsoft' | null>(null);
  const [imapOpen, setImapOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const connected = params.get('connected');
  const error = params.get('error');

  // Refresh while a mailbox is importing so progress is visible.
  const busy = list.data?.some((m) => m.status === 'INITIAL_SYNC' || m.status === 'CONNECTING');
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => void list.reload(), 5000);
    return () => clearInterval(t);
  }, [busy, list]);

  const dismiss = () => router.replace('/admin/mailboxes');

  return (
    <>
      <PageHeader
        title="Mailboxes"
        description="Company mailboxes connected to the CRM, their sync health and who may use them."
        actions={
          canConnect && (
            <div className="flex flex-wrap gap-2">
              {providers.data?.gmail && (
                <Button variant="primary" onClick={() => setConnectFor('google')}>
                  Connect Gmail
                </Button>
              )}
              {providers.data?.microsoft && (
                <Button variant="primary" onClick={() => setConnectFor('microsoft')}>
                  Connect Microsoft 365
                </Button>
              )}
              {providers.data?.imap && <Button onClick={() => setImapOpen(true)}>Connect other (IMAP)</Button>}
            </div>
          )
        }
      />
      {connected && (
        <div className="mb-4 flex items-start justify-between gap-3 rounded-md bg-success-soft px-4 py-3 text-[14px] text-success" role="status">
          <span>Mailbox connected. Existing mail is being imported; the status changes to “Syncing” when it is done.</span>
          <button className="underline" onClick={dismiss}>
            Dismiss
          </button>
        </div>
      )}
      {error && (
        <div className="mb-4 flex items-start justify-between gap-3 rounded-md bg-danger-soft px-4 py-3 text-[14px] text-danger" role="alert">
          <span>{CONNECT_ERRORS[error] ?? `Could not connect the mailbox (${error}).`}</span>
          <button className="underline" onClick={dismiss}>
            Dismiss
          </button>
        </div>
      )}
      {canConnect && providers.data && !providers.data.gmail && !providers.data.microsoft && (
        <div className="mb-4 rounded-md bg-warning-soft px-4 py-3 text-[14px] text-warning">
          Google and Microsoft sign-in are not set up on the server yet (add their client credentials to the API environment). IMAP mailboxes such as Zoho or Hostinger can be connected now.
        </div>
      )}
      <ErrorBanner error={list.error} />

      <Card>
        {list.loading && !list.data ? (
          <p className="p-4 text-text-3">Loading…</p>
        ) : !list.data?.length ? (
          <Empty title="No mailboxes yet">{canConnect ? 'Connect sales@, info@ and the other company mailboxes to start syncing.' : 'No mailbox has been shared with you.'}</Empty>
        ) : (
          <Table head={['Mailbox', 'Department', 'Status', 'Messages', 'Last sync', 'Push', '']}>
            {list.data.map((m) => (
              <tr key={m.id}>
                <Td>
                  <p className="font-medium">{m.emailAddress}</p>
                  <p className="text-[12.5px] text-text-3">
                    {PROVIDER_LABEL[m.provider]}
                    {m.displayName ? ` · ${m.displayName}` : ''}
                  </p>
                </Td>
                <Td className="text-text-2">{m.department?.name ?? '—'}</Td>
                <Td>
                  <Badge tone={STATUS[m.status].tone}>{STATUS[m.status].label}</Badge>
                  {m.lastError && m.status !== 'ACTIVE' && <p className="mt-1 max-w-xs truncate text-[12px] text-danger" title={m.lastError}>{m.lastError}</p>}
                </Td>
                <Td className="tabular-nums">
                  {m.messageCount.toLocaleString()}
                  <p className="text-[12px] text-text-3">{m.threadCount.toLocaleString()} conversations</p>
                </Td>
                <Td className="text-[13px]">
                  {formatDate(m.lastSuccessAt)}
                  <p className="text-[12px] text-text-3">{lag(m.newestMessageAt)}</p>
                </Td>
                <Td>{m.status === 'DISCONNECTED' ? '—' : m.pushActive ? <Badge tone="success">On</Badge> : <Badge>Polling</Badge>}</Td>
                <Td className="text-right">
                  {canManage && (
                    <Button size="sm" variant="ghost" onClick={() => setOpenId(m.id)}>
                      Manage
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <p className="mt-3 text-[13px] text-text-3">
        New mail arrives within seconds when push is on; every mailbox is also checked every 5 minutes. Conversations will be readable in the inbox (next phase).
      </p>

      {imapOpen && providers.data && (
        <ImapConnectModal providers={providers.data} onClose={() => setImapOpen(false)} onConnected={(id) => (setImapOpen(false), router.replace(`/admin/mailboxes?connected=${encodeURIComponent(id)}`), void list.reload())} />
      )}
      {connectFor && providers.data && <ConnectModal provider={connectFor} providers={providers.data} onClose={() => setConnectFor(null)} />}
      {openId && (
        <DetailModal
          id={openId}
          providers={providers.data ?? null}
          onClose={() => {
            setOpenId(null);
            void list.reload();
          }}
        />
      )}
    </>
  );
}

function ConnectModal({ provider, providers, onClose }: { provider: 'google' | 'microsoft'; providers: MailboxProvidersResponse; onClose: () => void }) {
  const depts = useLoad(() => api<DepartmentDetail[]>('/departments'), []);
  const [departmentId, setDepartmentId] = useState('');
  const [days, setDays] = useState(String(providers.initialSyncDays));
  const start = useAction(async () => {
    const { url } = await api<{ url: string }>(`/accounts/oauth/${provider}/start`, {
      method: 'POST',
      body: { departmentId: departmentId || null, syncDays: Number(days) },
    });
    window.location.assign(url);
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void start.run();
  };
  const fe = start.error?.fieldErrors() ?? {};
  return (
    <Modal
      open
      onClose={onClose}
      title={provider === 'google' ? 'Connect a Gmail / Google Workspace mailbox' : 'Connect a Microsoft 365 / Outlook mailbox'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="connect-form" pending={start.pending}>
            Continue to {provider === 'google' ? 'Google' : 'Microsoft'}
          </Button>
        </>
      }
    >
      <form id="connect-form" onSubmit={submit} className="flex flex-col gap-4">
        <ErrorBanner error={start.error && !Object.keys(fe).length ? start.error : null} />
        <p className="text-[14px] text-text-2">
          You will sign in to the mailbox you want to connect and allow the CRM to read and manage its mail. Sign in as that mailbox, not your own account, unless you are connecting your own.
        </p>
        <Field label="Department" htmlFor="c-dept" hint="Optional. Used for routing and reports." error={fe.departmentId}>
          <Select id="c-dept" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
            <option value="">None</option>
            {depts.data?.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Import existing mail from the last" htmlFor="c-days" hint="Days. Larger windows take longer to import." error={fe.syncDays}>
          <Input id="c-days" type="number" min={1} max={3650} value={days} onChange={(e) => setDays(e.target.value)} invalid={!!fe.syncDays} />
        </Field>
        {provider === 'google' && (
          <p className="rounded-md bg-surface-2 px-3 py-2 text-[13px] text-text-2">
            While the Google app is unverified (“Testing”), the mailbox must be listed as a test user and Google ends the connection after 7 days; the mailbox then shows “Reconnect needed”.
          </p>
        )}
      </form>
    </Modal>
  );
}

type GrantRow = { kind: 'user' | 'team' | 'department'; targetId: string; level: 'READ' | 'REPLY' | 'MANAGE' };

function DetailModal({ id, providers, onClose }: { id: string; providers: MailboxProvidersResponse | null; onClose: () => void }) {
  const { can } = useSession();
  const detail = useLoad(() => api<MailboxDetail>(`/accounts/${id}`), [id]);
  const depts = useLoad(() => api<DepartmentDetail[]>('/departments'), []);
  const people = useLoad(() => api<Page<UserSummary>>('/users', { query: { limit: 100 } }), []);
  const [grants, setGrants] = useState<GrantRow[] | null>(null);
  const [folders, setFolders] = useState<Record<string, boolean> | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [departmentId, setDepartmentId] = useState<string | null>(null);
  const d = detail.data;

  useEffect(() => {
    if (!d) return;
    setGrants(
      d.access.map((g) => ({
        kind: g.user ? 'user' : g.team ? 'team' : 'department',
        targetId: (g.user ?? g.team ?? g.department)!.id,
        level: g.level,
      })),
    );
    setFolders(Object.fromEntries(d.folders.map((f) => [f.id, f.syncEnabled])));
    setDisplayName(d.displayName ?? '');
    setDepartmentId(d.department?.id ?? '');
  }, [d]);

  const act = useAction(async (path: string, method: string = 'POST', body: unknown = undefined) => {
    await api(`/accounts/${id}${path}`, { method, body });
    await detail.reload();
  });
  const [imapEdit, setImapEdit] = useState(false);
  const reconnect = useAction(async () => {
    if (d!.provider === 'IMAP') return setImapEdit(true);
    const provider = d!.provider === 'GMAIL' ? 'google' : 'microsoft';
    const { url } = await api<{ url: string }>(`/accounts/oauth/${provider}/start`, { method: 'POST', body: { departmentId: d!.department?.id ?? null } });
    window.location.assign(url);
  });
  const teams = depts.data?.flatMap((x) => x.teams) ?? [];

  const disconnect = () => {
    if (!d || !providers) return;
    const msg = `Disconnect ${d.emailAddress}?\n\nSyncing stops and the CRM's access is removed now. Its stored mail is deleted after ${providers.retentionDays} days unless the mailbox is reconnected before then.`;
    if (confirm(msg)) void act.run('', 'DELETE');
  };

  const saveGrants = () =>
    void act.run('/access', 'PUT', {
      grants: (grants ?? [])
        .filter((g) => g.targetId)
        .map((g) => ({ [g.kind === 'user' ? 'userId' : g.kind === 'team' ? 'teamId' : 'departmentId']: g.targetId, level: g.level })),
    });

  const inactive = d?.status === 'DISCONNECTED';
  if (imapEdit && d && providers)
    return (
      <ImapConnectModal
        providers={providers}
        existing={{ id: d.id, emailAddress: d.emailAddress, displayName: d.displayName, departmentId: d.department?.id ?? null }}
        onClose={() => setImapEdit(false)}
        onConnected={() => (setImapEdit(false), void detail.reload())}
      />
    );
  return (
    <Modal open wide onClose={onClose} title={d ? d.emailAddress : 'Mailbox'}>
      <ErrorBanner error={detail.error ?? act.error ?? reconnect.error} />
      {!d ? (
        <p className="text-text-3">Loading…</p>
      ) : (
        <div className="flex flex-col gap-6">
          <section className="flex flex-wrap items-center gap-2">
            <Badge tone={STATUS[d.status].tone}>{STATUS[d.status].label}</Badge>
            <span className="text-[13px] text-text-2">
              {PROVIDER_LABEL[d.provider]} · connected by {d.connectedBy.name} · {d.messageCount.toLocaleString()} messages since {formatDate(d.syncFromDate)}
            </span>
          </section>
          {d.lastError && d.status !== 'ACTIVE' && <p className="rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger">{d.lastError}</p>}
          {d.status === 'DISCONNECTED' && (
            <p className="rounded-md bg-surface-2 px-3 py-2 text-[13px] text-text-2">
              {d.purgedAt ? `Stored mail was deleted on ${formatDate(d.purgedAt)}.` : `Stored mail will be deleted on ${formatDate(d.purgeAfter)} unless the mailbox is reconnected.`}
            </p>
          )}

          <section className="flex flex-wrap gap-2">
            {(d.status === 'NEEDS_REAUTH' || d.status === 'DISCONNECTED') && can('account.connect') && (
              <Button variant="primary" onClick={() => void reconnect.run()} pending={reconnect.pending}>
                Reconnect
              </Button>
            )}
            {!inactive && d.status !== 'PAUSED' && d.status !== 'NEEDS_REAUTH' && (
              <>
                <Button onClick={() => void act.run('/sync')} pending={act.pending}>
                  Sync now
                </Button>
                <Button onClick={() => confirm('Re-read the whole import window? Stored mail is not duplicated.') && void act.run('/sync?full=true')}>Full resync</Button>
              </>
            )}
            {d.provider === 'IMAP' && !inactive && d.status !== 'NEEDS_REAUTH' && can('account.connect') && <Button onClick={() => setImapEdit(true)}>Change password or server</Button>}
            {!inactive && d.status !== 'PAUSED' && <Button onClick={() => void act.run('/pause')}>Pause</Button>}
            {d.status === 'PAUSED' && <Button onClick={() => void act.run('/resume')}>Resume</Button>}
            {!inactive && (
              <Button variant="danger" onClick={disconnect}>
                Disconnect
              </Button>
            )}
          </section>

          {!inactive && (
            <section>
              <h3 className="mb-2 text-[14px] font-semibold">Settings</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Display name" htmlFor="m-name">
                  <Input id="m-name" value={displayName ?? ''} onChange={(e) => setDisplayName(e.target.value)} placeholder="e.g. Sales" />
                </Field>
                <Field label="Department" htmlFor="m-dept">
                  <Select id="m-dept" value={departmentId ?? ''} onChange={(e) => setDepartmentId(e.target.value)}>
                    <option value="">None</option>
                    {depts.data?.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Button className="mt-2" size="sm" onClick={() => void act.run('', 'PATCH', { displayName: displayName || null, departmentId: departmentId || null })}>
                Save settings
              </Button>
              <label className="mt-3 flex items-start gap-2 text-[14px]">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={d.aiEnabled}
                  onChange={(e) => {
                    const on = e.target.checked;
                    if (!on || confirm(`Allow the AI assistant for ${d.emailAddress}? Its email content will be sent to the AI provider (OpenAI) for summaries, classification and reply suggestions.`)) {
                      void act.run('', 'PATCH', { aiEnabled: on });
                    }
                  }}
                />
                <span>
                  Allow the AI assistant for this mailbox
                  <span className="block text-[12.5px] text-text-3">When off, no email from this mailbox is ever sent to the AI provider (e.g. for HR or finance mail).</span>
                </span>
              </label>
            </section>
          )}

          {!inactive && d.folders.length > 0 && folders && (
            <section>
              <h3 className="mb-1 text-[14px] font-semibold">Folders</h3>
              <p className="mb-2 text-[13px] text-text-3">{d.provider === 'GMAIL' ? 'Labels shown in the CRM.' : 'Folders that are synced.'}</p>
              <div className="grid gap-1 sm:grid-cols-2">
                {d.folders.map((f) => (
                  <label key={f.id} className="flex items-center gap-2 text-[14px]">
                    <input type="checkbox" checked={folders[f.id] ?? false} onChange={(e) => setFolders({ ...folders, [f.id]: e.target.checked })} />
                    {f.name}
                    <span className="text-[12px] text-text-3">{f.messageCount.toLocaleString()}</span>
                  </label>
                ))}
              </div>
              <Button className="mt-2" size="sm" onClick={() => void act.run('/folders', 'PUT', { folders: Object.entries(folders).map(([folderId, syncEnabled]) => ({ folderId, syncEnabled })) })}>
                Save folders
              </Button>
            </section>
          )}

          {!inactive && grants && (
            <section>
              <h3 className="mb-1 text-[14px] font-semibold">Who can use this mailbox</h3>
              <p className="mb-2 text-[13px] text-text-3">Read: see its conversations. Reply: also send from it. Manage: also change its settings.</p>
              <div className="flex flex-col gap-2">
                {grants.map((g, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2">
                    <Select aria-label="Grant to" value={g.kind} onChange={(e) => setGrants(grants.map((x, j) => (j === i ? { ...x, kind: e.target.value as GrantRow['kind'], targetId: '' } : x)))} className="w-36">
                      <option value="user">Employee</option>
                      <option value="team">Team</option>
                      <option value="department">Department</option>
                    </Select>
                    <Select aria-label="Who" value={g.targetId} onChange={(e) => setGrants(grants.map((x, j) => (j === i ? { ...x, targetId: e.target.value } : x)))} className="min-w-48 flex-1">
                      <option value="">Choose…</option>
                      {(g.kind === 'user' ? (people.data?.items ?? []).map((u) => ({ id: u.id, name: `${u.name} (${u.email})` })) : g.kind === 'team' ? teams : (depts.data ?? [])).map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                    </Select>
                    <Select aria-label="Level" value={g.level} onChange={(e) => setGrants(grants.map((x, j) => (j === i ? { ...x, level: e.target.value as GrantRow['level'] } : x)))} className="w-28">
                      <option value="READ">Read</option>
                      <option value="REPLY">Reply</option>
                      <option value="MANAGE">Manage</option>
                    </Select>
                    <Button size="sm" variant="ghost" onClick={() => setGrants(grants.filter((_, j) => j !== i))} aria-label="Remove">
                      Remove
                    </Button>
                  </div>
                ))}
              </div>
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => setGrants([...grants, { kind: 'user', targetId: '', level: 'READ' }])}>
                  Add access
                </Button>
                <Button size="sm" onClick={saveGrants}>
                  Save access
                </Button>
              </div>
            </section>
          )}

          <section>
            <h3 className="mb-2 text-[14px] font-semibold">Recent sync runs</h3>
            {d.syncLogs.length === 0 ? (
              <p className="text-[13px] text-text-3">None yet.</p>
            ) : (
              <Table head={['Started', 'Kind', 'Result', 'Added', 'Updated']}>
                {d.syncLogs.map((l) => (
                  <tr key={l.id}>
                    <Td className="text-[13px] whitespace-nowrap">{formatDate(l.startedAt)}</Td>
                    <Td className="text-[13px]">{l.kind.toLowerCase()}</Td>
                    <Td>
                      <Badge tone={l.status === 'SUCCEEDED' ? 'success' : l.status === 'RUNNING' ? 'accent' : 'danger'}>{l.status.toLowerCase()}</Badge>
                      {l.error && <p className="mt-1 max-w-xs truncate text-[12px] text-danger" title={l.error}>{l.error}</p>}
                    </Td>
                    <Td className="tabular-nums">{l.messagesAdded}</Td>
                    <Td className="tabular-nums">{l.messagesUpdated}</Td>
                  </tr>
                ))}
              </Table>
            )}
          </section>
        </div>
      )}
    </Modal>
  );
}

export default function Page() {
  return (
    <Suspense>
      <MailboxesPage />
    </Suspense>
  );
}
