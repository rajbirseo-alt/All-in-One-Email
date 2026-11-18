'use client';

import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';

type Handler = (data: unknown) => void;

interface LiveValue {
  on: (event: string, handler: Handler) => () => void;
}

const Ctx = createContext<LiveValue | null>(null);

/**
 * One Server-Sent Events stream per tab (/api/v1/events), shared by the bell, the inbox and
 * anything else that wants live updates. The server sends ids only; listeners refetch.
 */
export function LiveEventsProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const listeners = useRef(new Map<string, Set<Handler>>());
  const sources = useRef(new Map<string, (ev: Event) => void>());
  const es = useRef<EventSource | null>(null);

  const attach = (event: string) => {
    if (!es.current || sources.current.has(event)) return;
    const fn = (ev: Event) => {
      let data: unknown = null;
      try {
        data = JSON.parse((ev as MessageEvent).data as string);
      } catch {
        /* keep null */
      }
      for (const h of listeners.current.get(event) ?? []) h(data);
    };
    sources.current.set(event, fn);
    es.current.addEventListener(event, fn);
  };

  useEffect(() => {
    const source = new EventSource('/api/v1/events');
    es.current = source;
    sources.current.clear();
    for (const event of listeners.current.keys()) attach(event);
    source.addEventListener('session.ended', () => {
      source.close();
      router.replace('/login');
    });
    return () => {
      source.close();
      es.current = null;
      sources.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  const value = useRef<LiveValue>({
    on(event, handler) {
      let set = listeners.current.get(event);
      if (!set) listeners.current.set(event, (set = new Set()));
      set.add(handler);
      attach(event);
      return () => set!.delete(handler);
    },
  }).current;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Calls `handler` for each live event of this type (the latest handler is always used). */
export function useLiveEvent(event: string, handler: Handler) {
  const live = useContext(Ctx);
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!live) return;
    return live.on(event, (d) => ref.current(d));
  }, [live, event]);
}
