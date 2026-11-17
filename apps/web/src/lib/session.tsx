'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { MeResponse, PermissionKey } from '@crm/shared';
import { api, ApiError } from './api';

interface SessionValue {
  me: MeResponse;
  can: (p: PermissionKey) => boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<SessionValue | null>(null);

export function useSession() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}

/** Loads /auth/me; redirects to /login when signed out. Renders nothing until known. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setMe(await api<MeResponse>('/auth/me'));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) router.replace('/login');
      else setFailed(e instanceof Error ? e.message : 'Could not load your session');
    }
  }, [router]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    router.replace('/login');
  }, [router]);

  if (failed) {
    return (
      <div className="grid min-h-screen place-items-center p-4 text-center">
        <div>
          <p className="font-medium">Could not load the app</p>
          <p className="mt-1 text-text-2">{failed}</p>
          <button className="mt-4 text-accent underline" onClick={() => location.reload()}>
            Try again
          </button>
        </div>
      </div>
    );
  }
  if (!me) return <div className="grid min-h-screen place-items-center text-text-3">Loading…</div>;

  const can = (p: PermissionKey) => me.permissions[p] !== undefined;
  return <Ctx.Provider value={{ me, can, refresh, logout }}>{children}</Ctx.Provider>;
}
