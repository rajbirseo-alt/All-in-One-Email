'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api';

/** Small data-fetching hook: loading / error / reload, ignores stale responses. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);

  const run = useCallback(async () => {
    const id = ++seq.current;
    setLoading(true);
    try {
      const d = await load();
      if (id === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (id === seq.current) setError(e instanceof ApiError ? e : new ApiError(0, 'NETWORK', 'Could not reach the server'));
    } finally {
      if (id === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    void run();
  }, [run]);

  return { data, error, loading, reload: run, setData };
}

/** Wraps a mutation with pending + error state. */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const run = useCallback(
    async (...args: A): Promise<R | undefined> => {
      setPending(true);
      setError(null);
      try {
        return await fn(...args);
      } catch (e) {
        setError(e instanceof ApiError ? e : new ApiError(0, 'NETWORK', 'Could not reach the server'));
        return undefined;
      } finally {
        setPending(false);
      }
    },
    [fn],
  );
  return { run, pending, error, setError };
}
