'use client';

import { useEffect, useState } from 'react';
import type { NotificationPrefs } from '@crm/shared';
import { api, ApiError } from '@/lib/api';
import { useAction, useLoad } from '@/lib/hooks';
import { Button, Card, ErrorBanner, PageHeader, Table, Td } from '@/components/ui';

type Device = { endpoint: string; userAgent: string | null; createdAt: string };

function urlBase64ToUint8Array(base64: string) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

const pushSupported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

/** Short device label from a user agent ("Chrome on Android"). */
function deviceName(ua: string | null) {
  if (!ua) return 'Unknown browser';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

export default function NotificationSettingsPage() {
  const prefs = useLoad(() => api<NotificationPrefs>('/notification-preferences'), []);
  const devices = useLoad(() => api<Device[]>('/push-subscriptions'), []);
  const [draft, setDraft] = useState<NotificationPrefs['items'] | null>(null);
  const [thisDevice, setThisDevice] = useState<string | null>(null);
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>('default');
  const [pushError, setPushError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setDraft(prefs.data?.items ?? null), [prefs.data]);
  useEffect(() => {
    if (!pushSupported()) return setPermission('unsupported');
    setPermission(Notification.permission);
    void navigator.serviceWorker.getRegistration('/').then(async (reg) => setThisDevice((await reg?.pushManager.getSubscription())?.endpoint ?? null));
  }, []);

  const save = useAction(async (items: NotificationPrefs['items']) => {
    const r = await api<NotificationPrefs>('/notification-preferences', { method: 'PUT', body: { items: items.map(({ type, inApp, push }) => ({ type, inApp, push })) } });
    prefs.setData(r);
  });

  const enablePush = async () => {
    setPushError(null);
    setBusy(true);
    try {
      const cfg = await api<{ enabled: boolean; publicKey: string | null }>('/push-subscriptions/config');
      if (!cfg.enabled || !cfg.publicKey) throw new ApiError(409, 'PUSH_DISABLED', 'Browser notifications are not set up on the server yet.');
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== 'granted') throw new ApiError(0, 'DENIED', 'Notifications are blocked for this site. Allow them in your browser settings, then try again.');
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(cfg.publicKey) }));
      const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
      await api('/push-subscriptions', { method: 'POST', body: { endpoint: json.endpoint, keys: json.keys } });
      setThisDevice(json.endpoint);
      await devices.reload();
    } catch (e) {
      setPushError(e instanceof ApiError ? e : new ApiError(0, 'PUSH', (e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const removeDevice = async (endpoint: string) => {
    setPushError(null);
    try {
      await api('/push-subscriptions', { method: 'DELETE', body: { endpoint } });
      if (endpoint === thisDevice) {
        const reg = await navigator.serviceWorker.getRegistration('/');
        await (await reg?.pushManager.getSubscription())?.unsubscribe();
        setThisDevice(null);
      }
      await devices.reload();
    } catch (e) {
      setPushError(e as ApiError);
    }
  };

  const set = (type: string, key: 'inApp' | 'push', value: boolean) => setDraft((d) => d?.map((i) => (i.type === type ? { ...i, [key]: value } : i)) ?? null);
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(prefs.data?.items);
  const pushAvailable = !!prefs.data?.pushAvailable;

  return (
    <>
      <PageHeader title="Notifications" description="Choose what you hear about in the bell and on your devices." />
      <div className="flex max-w-3xl flex-col gap-4">
        <ErrorBanner error={prefs.error ?? save.error} />
        <Card>
          <Table head={['Notification', 'In the bell', 'On my devices']}>
            {draft?.map((i) => (
              <tr key={i.type} className="border-b border-border last:border-0">
                <Td>
                  <p className="font-medium">{i.label}</p>
                  <p className="text-[12.5px] text-text-3">{i.description}</p>
                </Td>
                <Td>
                  <input type="checkbox" aria-label={`${i.label} in the bell`} checked={i.inApp} onChange={(e) => set(i.type, 'inApp', e.target.checked)} />
                </Td>
                <Td>
                  <input type="checkbox" aria-label={`${i.label} on my devices`} checked={i.push} disabled={!pushAvailable} onChange={(e) => set(i.type, 'push', e.target.checked)} />
                </Td>
              </tr>
            ))}
          </Table>
          <div className="flex justify-end gap-2 border-t border-border p-3">
            <Button variant="ghost" disabled={!dirty} onClick={() => setDraft(prefs.data?.items ?? null)}>
              Reset
            </Button>
            <Button variant="primary" disabled={!dirty} pending={save.pending} onClick={() => draft && void save.run(draft)}>
              Save
            </Button>
          </div>
        </Card>

        <Card className="p-4">
          <h2 className="text-[15px] font-semibold">Browser notifications</h2>
          {!pushAvailable ? (
            <p className="mt-1 text-text-2">Your administrator has not switched on browser notifications yet. You still get everything in the bell.</p>
          ) : permission === 'unsupported' ? (
            <p className="mt-1 text-text-2">This browser does not support notifications. On iPhone, add the CRM to your Home Screen first.</p>
          ) : (
            <>
              <p className="mt-1 text-text-2">Get a pop-up on this computer or phone, even when the CRM tab is closed. Turn it on separately on each device.</p>
              <ErrorBanner error={pushError} />
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {thisDevice && devices.data?.some((d) => d.endpoint === thisDevice) ? (
                  <Button onClick={() => void removeDevice(thisDevice)}>Turn off on this device</Button>
                ) : (
                  <Button variant="primary" pending={busy} onClick={() => void enablePush()}>
                    Turn on for this device
                  </Button>
                )}
                {permission === 'denied' && <span className="text-[13px] text-danger">Blocked in this browser’s site settings.</span>}
              </div>
              {!!devices.data?.length && (
                <ul className="mt-4 flex flex-col divide-y divide-border rounded-md border border-border">
                  {devices.data.map((d) => (
                    <li key={d.endpoint} className="flex items-center justify-between gap-2 px-3 py-2 text-[13.5px]">
                      <span>
                        {deviceName(d.userAgent)}
                        {d.endpoint === thisDevice && <span className="text-text-3"> · this device</span>}
                        <span className="block text-[12px] text-text-3">Added {new Date(d.createdAt).toLocaleDateString()}</span>
                      </span>
                      <Button size="sm" variant="ghost" onClick={() => void removeDevice(d.endpoint)}>
                        Remove
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </Card>
      </div>
    </>
  );
}
