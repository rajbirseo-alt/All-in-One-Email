'use client';

import { useEffect, useState } from 'react';
import { IMAP_PRESETS, type DepartmentDetail, type ImapSettingsView, type ImapTestResult, type MailboxProvidersResponse } from '@crm/shared';
import { api, ApiError } from '@/lib/api';
import { useLoad } from '@/lib/hooks';
import { Badge, Button, ErrorBanner, Field, Input, Modal, Select } from '@/components/ui';

type Security = 'TLS' | 'STARTTLS';
interface Server {
  host: string;
  port: string;
  security: Security;
}

const STEP_LABEL: Record<string, string> = { dns: 'Server names', imap: 'Reading mail (IMAP)', folders: 'Folders', smtp: 'Sending mail (SMTP)' };

function ServerFields({ id, label, value, onChange, errors }: { id: string; label: string; value: Server; onChange: (v: Server) => void; errors: Record<string, string> }) {
  return (
    <fieldset className="grid grid-cols-[minmax(0,1fr)_90px_130px] gap-2">
      <legend className="mb-1 text-[13px] font-medium">{label}</legend>
      <Input aria-label={`${label} server`} id={`${id}-host`} placeholder="mail.example.com" value={value.host} onChange={(e) => onChange({ ...value, host: e.target.value.trim() })} invalid={!!errors[`${id}.host`]} />
      <Input aria-label={`${label} port`} type="number" min={1} max={65535} value={value.port} onChange={(e) => onChange({ ...value, port: e.target.value })} invalid={!!errors[`${id}.port`]} />
      <Select aria-label={`${label} security`} value={value.security} onChange={(e) => onChange({ ...value, security: e.target.value as Security })}>
        <option value="TLS">SSL/TLS</option>
        <option value="STARTTLS">STARTTLS</option>
      </Select>
      {(errors[`${id}.host`] || errors[`${id}.port`]) && <p className="col-span-3 text-[12.5px] text-danger">{errors[`${id}.host`] ?? errors[`${id}.port`]}</p>}
    </fieldset>
  );
}

/**
 * Connect (or reconnect / change the password of) an IMAP/SMTP mailbox: Zoho, Hostinger,
 * GoDaddy, cPanel hosting and any other provider. Nothing is saved until the test passes.
 */
export function ImapConnectModal({
  providers,
  existing,
  onClose,
  onConnected,
}: {
  providers: MailboxProvidersResponse;
  existing?: { id: string; emailAddress: string; displayName: string | null; departmentId: string | null };
  onClose: () => void;
  onConnected: (id: string) => void;
}) {
  const depts = useLoad(() => (existing ? Promise.resolve([] as DepartmentDetail[]) : api<DepartmentDetail[]>('/departments')), [existing]);
  const [preset, setPreset] = useState<string>(existing ? 'other' : 'zoho');
  const [email, setEmail] = useState(existing?.emailAddress ?? '');
  const [displayName, setDisplayName] = useState(existing?.displayName ?? '');
  const [username, setUsername] = useState(existing?.emailAddress ?? '');
  const [usernameTouched, setUsernameTouched] = useState(!!existing);
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [imap, setImap] = useState<Server>({ host: 'imap.zoho.com', port: '993', security: 'TLS' });
  const [smtp, setSmtp] = useState<Server>({ host: 'smtp.zoho.com', port: '465', security: 'TLS' });
  const [departmentId, setDepartmentId] = useState('');
  const [days, setDays] = useState(String(providers.initialSyncDays));
  const [result, setResult] = useState<ImapTestResult | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState<'test' | 'connect' | null>(null);

  // Reconnect: start from the saved settings (never the password).
  useEffect(() => {
    if (!existing) return;
    void api<ImapSettingsView>(`/accounts/${existing.id}/imap`).then((s) => {
      setUsername(s.username);
      setImap({ host: s.imap.host, port: String(s.imap.port), security: s.imap.security });
      setSmtp({ host: s.smtp.host, port: String(s.smtp.port), security: s.smtp.security });
    }, () => undefined);
  }, [existing]);

  const domain = email.split('@')[1] ?? '';
  const applyPreset = (id: string) => {
    setPreset(id);
    const p = IMAP_PRESETS.find((x) => x.id === id);
    if (!p || id === 'other') return;
    const fill = (h: string) => h.replace('{domain}', domain || 'example.com');
    setImap({ host: fill(p.imap.host), port: String(p.imap.port), security: p.imap.security });
    setSmtp({ host: fill(p.smtp.host), port: String(p.smtp.port), security: p.smtp.security });
  };
  const chosen = IMAP_PRESETS.find((x) => x.id === preset);

  const body = () => ({
    email,
    displayName: displayName || null,
    username,
    password,
    imap: { host: imap.host, port: Number(imap.port), security: imap.security },
    smtp: { host: smtp.host, port: Number(smtp.port), security: smtp.security },
  });

  const test = async () => {
    setPending('test');
    setError(null);
    setResult(null);
    try {
      setResult(await api<ImapTestResult>('/accounts/imap/test', { method: 'POST', body: body() }));
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setPending(null);
    }
  };
  const connect = async () => {
    setPending('connect');
    setError(null);
    try {
      const r = await api<{ id: string }>('/accounts/imap', { method: 'POST', body: { ...body(), ...(existing ? {} : { departmentId: departmentId || null, syncDays: Number(days) }) } });
      onConnected(r.id);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setPending(null);
    }
  };
  const fe = error?.fieldErrors() ?? {};
  const stepErrors = error?.code === 'VALIDATION_FAILED' && ['dns', 'imap', 'folders', 'smtp'].some((k) => fe[k]);

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={existing ? `Reconnect ${existing.emailAddress}` : 'Connect another mailbox (IMAP / SMTP)'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button onClick={() => void test()} pending={pending === 'test'} disabled={!email || !password || !imap.host || !smtp.host}>
            Test connection
          </Button>
          <Button variant="primary" onClick={() => void connect()} pending={pending === 'connect'} disabled={!email || !password || !imap.host || !smtp.host}>
            {existing ? 'Save and reconnect' : 'Connect'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error && (!Object.keys(fe).length || stepErrors) && <ErrorBanner error={stepErrors ? { message: `${error.message}: ${Object.values(fe).join(' ')}` } : error} />}
        {!existing && (
          <Field label="Provider" htmlFor="i-preset" hint={chosen?.note ?? undefined}>
            <Select id="i-preset" value={preset} onChange={(e) => applyPreset(e.target.value)}>
              {IMAP_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Email address" htmlFor="i-email" error={fe.email}>
            <Input
              id="i-email"
              type="email"
              value={email}
              disabled={!!existing}
              onChange={(e) => {
                setEmail(e.target.value.trim());
                if (!usernameTouched) setUsername(e.target.value.trim());
                if (preset === 'cpanel') {
                  const d = e.target.value.split('@')[1] ?? '';
                  if (d) {
                    setImap((s) => ({ ...s, host: `mail.${d}` }));
                    setSmtp((s) => ({ ...s, host: `mail.${d}` }));
                  }
                }
              }}
            />
          </Field>
          <Field label="Display name" htmlFor="i-name" hint="Shown as the sender name.">
            <Input id="i-name" value={displayName} maxLength={120} onChange={(e) => setDisplayName(e.target.value)} />
          </Field>
          <Field label="Username" htmlFor="i-user" hint="Usually the email address." error={fe.username}>
            <Input id="i-user" value={username} autoComplete="off" onChange={(e) => (setUsername(e.target.value), setUsernameTouched(true))} />
          </Field>
          <Field label={chosen?.appPassword ? 'App password' : 'Password'} htmlFor="i-pass" hint={chosen?.appPassword ? 'With two-step sign-in on, create an app password at the provider.' : 'Stored encrypted; never shown again.'} error={fe.password}>
            <div className="flex gap-2">
              <Input id="i-pass" type={show ? 'text' : 'password'} value={password} autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} />
              <Button size="sm" className="h-9" onClick={() => setShow((s) => !s)} aria-pressed={show}>
                {show ? 'Hide' : 'Show'}
              </Button>
            </div>
          </Field>
        </div>
        <ServerFields id="imap" label="Incoming (IMAP)" value={imap} onChange={setImap} errors={fe} />
        <ServerFields id="smtp" label="Outgoing (SMTP)" value={smtp} onChange={setSmtp} errors={fe} />
        {!existing && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Department" htmlFor="i-dept" hint="Optional. Used for routing and reports.">
              <Select id="i-dept" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
                <option value="">None</option>
                {depts.data?.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Import existing mail from the last" htmlFor="i-days" hint="Days." error={fe.syncDays}>
              <Input id="i-days" type="number" min={1} max={3650} value={days} onChange={(e) => setDays(e.target.value)} />
            </Field>
          </div>
        )}
        {result && (
          <ul className="flex flex-col gap-1 rounded-md border border-border p-3 text-[13.5px]" aria-label="Connection test">
            {result.steps.map((s) => (
              <li key={s.step} className="flex items-start gap-2">
                <Badge tone={s.ok ? 'success' : 'danger'}>{s.ok ? 'OK' : 'Failed'}</Badge>
                <span>
                  <strong className="font-medium">{STEP_LABEL[s.step]}:</strong> {s.message}
                </span>
              </li>
            ))}
            {result.ok && <li className="text-text-2">Everything works. Choose {existing ? '“Save and reconnect”' : '“Connect”'}.</li>}
          </ul>
        )}
        <p className="text-[12.5px] text-text-3">Only encrypted connections are used (TLS 1.2 or newer, with a valid certificate). New mail arrives within seconds through IMAP IDLE, and the mailbox is also checked every 5 minutes.</p>
      </div>
    </Modal>
  );
}
