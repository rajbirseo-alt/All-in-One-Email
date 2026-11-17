'use client';

import { useState, type FormEvent } from 'react';
import type { SessionInfo } from '@crm/shared';
import { api } from '@/lib/api';
import { useAction, useLoad } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { Badge, Button, Card, ErrorBanner, Field, Input, PageHeader, Select, formatDate } from '@/components/ui';
import { TotpSetup } from '@/components/totp-setup';

const TIMEZONES = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : ['UTC'];

export default function AccountPage() {
  const { me, refresh } = useSession();
  const [name, setName] = useState(me.user.name);
  const [timezone, setTimezone] = useState(me.user.timezone);
  const [savedProfile, setSavedProfile] = useState(false);

  const saveProfile = useAction(async (e: FormEvent) => {
    e.preventDefault();
    await api('/me', { method: 'PATCH', body: { name, timezone } });
    await refresh();
    setSavedProfile(true);
  });

  const [absent, setAbsent] = useState(me.user.isAbsent);
  const [until, setUntil] = useState(me.user.absentUntil?.slice(0, 10) ?? '');
  const saveAbsence = useAction(async () => {
    await api(`/users/${me.user.id}/absence`, {
      method: 'PUT',
      body: { isAbsent: absent, absentUntil: absent && until ? new Date(`${until}T23:59:59`).toISOString() : null },
    });
    await refresh();
  });

  const sessions = useLoad(() => api<SessionInfo[]>('/auth/sessions'), []);
  const revoke = useAction(async (id: string) => {
    await api(`/auth/sessions/${id}`, { method: 'DELETE' });
    await sessions.reload();
  });

  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [code, setCode] = useState('');
  const startMfa = useAction(async () => setSetup(await api('/auth/mfa/self/start', { method: 'POST' })));
  const confirmMfa = useAction(async (e: FormEvent) => {
    e.preventDefault();
    await api('/auth/mfa/self/confirm', { method: 'POST', body: { code } });
    setSetup(null);
    setCode('');
    await refresh();
  });
  const disableMfa = useAction(async () => {
    if (!confirm('Turn off two-factor authentication?')) return;
    await api('/auth/mfa/self', { method: 'DELETE' });
    await refresh();
  });

  return (
    <>
      <PageHeader title="My account" description={`${me.user.email} · ${me.user.role.name}${me.user.department ? ` · ${me.user.department.name}` : ''}`} />
      <div className="grid max-w-3xl gap-4">
        <Card className="p-5">
          <h2 className="mb-4 font-semibold">Profile</h2>
          <form onSubmit={(e) => void saveProfile.run(e)} className="grid gap-4 sm:grid-cols-2">
            {saveProfile.error && (
              <div className="sm:col-span-2">
                <ErrorBanner error={saveProfile.error} />
              </div>
            )}
            <Field label="Name" htmlFor="a-name">
              <Input id="a-name" required value={name} onChange={(e) => { setName(e.target.value); setSavedProfile(false); }} />
            </Field>
            <Field label="Time zone" htmlFor="a-tz" hint="Used for SLA working hours and dates.">
              <Select id="a-tz" value={timezone} onChange={(e) => { setTimezone(e.target.value); setSavedProfile(false); }}>
                {!TIMEZONES.includes(timezone) && <option value={timezone}>{timezone}</option>}
                {TIMEZONES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex items-center gap-3 sm:col-span-2">
              <Button variant="primary" type="submit" pending={saveProfile.pending}>
                Save profile
              </Button>
              {savedProfile && <span className="text-[13px] text-success">Saved</span>}
            </div>
          </form>
        </Card>

        <Card className="p-5">
          <h2 className="font-semibold">Away status</h2>
          <p className="mt-0.5 mb-4 text-[13px] text-text-2">While you are away, automatic assignment skips you (assignment arrives in Phase 5).</p>
          <ErrorBanner error={saveAbsence.error} />
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex h-9 items-center gap-2">
              <input type="checkbox" checked={absent} onChange={(e) => setAbsent(e.target.checked)} className="size-4 accent-[var(--accent)]" />
              I’m away
            </label>
            {absent && (
              <Field label="Until (optional)" htmlFor="a-until">
                <Input id="a-until" type="date" value={until} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setUntil(e.target.value)} />
              </Field>
            )}
            <Button onClick={() => void saveAbsence.run()} pending={saveAbsence.pending}>
              Update
            </Button>
            {me.user.isAbsent && <Badge tone="warning">Away{me.user.absentUntil ? ` until ${formatDate(me.user.absentUntil)}` : ''}</Badge>}
          </div>
        </Card>

        <Card className="p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-semibold">Two-factor authentication</h2>
              <p className="mt-0.5 text-[13px] text-text-2">Applies to password sign-in. Google and Microsoft sign-in use that account’s own security, so turn on 2-step verification there too.</p>
            </div>
            {me.user.mfaEnabled ? <Badge tone="success">On</Badge> : <Badge>Off</Badge>}
          </div>
          <div className="mt-4">
            <ErrorBanner error={startMfa.error ?? confirmMfa.error ?? disableMfa.error} />
            {me.user.mfaEnabled ? (
              <Button variant="danger" onClick={() => void disableMfa.run()} pending={disableMfa.pending}>
                Turn off
              </Button>
            ) : setup ? (
              <form onSubmit={(e) => void confirmMfa.run(e)} className="flex flex-col gap-4">
                <TotpSetup {...setup} />
                <div className="flex items-end gap-2">
                  <Field label="6-digit code" htmlFor="a-code">
                    <Input id="a-code" inputMode="numeric" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} className="w-36 font-mono tracking-[0.3em]" />
                  </Field>
                  <Button variant="primary" type="submit" pending={confirmMfa.pending}>
                    Turn on
                  </Button>
                </div>
              </form>
            ) : (
              <Button onClick={() => void startMfa.run()} pending={startMfa.pending}>
                Set up authenticator app
              </Button>
            )}
          </div>
        </Card>

        <Card>
          <div className="p-5 pb-3">
            <h2 className="font-semibold">Where you’re signed in</h2>
          </div>
          <ErrorBanner error={sessions.error ?? revoke.error} />
          <ul>
            {sessions.data?.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-5 py-3">
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium" title={s.userAgent ?? ''}>
                    {describeAgent(s.userAgent)} {s.current && <Badge tone="accent">this device</Badge>}
                  </p>
                  <p className="text-[12.5px] text-text-3">
                    {s.ip ?? 'unknown IP'} · signed in {formatDate(s.createdAt)} via {s.authMethod} · last active {formatDate(s.lastSeenAt)}
                  </p>
                </div>
                {!s.current && (
                  <Button size="sm" variant="ghost" onClick={() => void revoke.run(s.id)} pending={revoke.pending}>
                    Sign out
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}

function describeAgent(ua: string | null) {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}
