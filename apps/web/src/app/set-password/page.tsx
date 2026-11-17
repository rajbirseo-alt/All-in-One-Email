'use client';

import { Suspense, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { Button, Field, Input } from '@/components/ui';

function SetPasswordInner() {
  const token = useSearchParams().get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) return setError('The passwords do not match.');
    setPending(true);
    setError(null);
    try {
      await api('/auth/password/set', { method: 'POST', body: { token, password } });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? (err.fieldErrors().password ?? err.message) : 'Something went wrong.');
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-[380px] rounded-lg border border-border bg-surface p-6 shadow-sm">
        <h1 className="text-[18px] font-semibold">Set your password</h1>
        {done ? (
          <>
            <p className="mt-2 text-text-2">Your password is set. You can now sign in.</p>
            <Link href="/login" className="mt-4 inline-flex h-9 items-center rounded-md bg-accent px-3.5 font-medium text-accent-text hover:bg-accent-hover">
              Go to sign in
            </Link>
          </>
        ) : !token ? (
          <p className="mt-2 text-text-2">This link is incomplete. Ask an administrator for a new one.</p>
        ) : (
          <form onSubmit={submit} className="mt-4 flex flex-col gap-4">
            {error && (
              <div role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger">
                {error}
              </div>
            )}
            <Field label="New password" htmlFor="pw" hint="At least 12 characters. A short sentence works well.">
              <Input id="pw" type="password" autoComplete="new-password" minLength={12} required value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Field label="Confirm password" htmlFor="pw2">
              <Input id="pw2" type="password" autoComplete="new-password" minLength={12} required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </Field>
            <Button variant="primary" type="submit" pending={pending} className="h-10">
              Set password
            </Button>
          </form>
        )}
      </div>
    </main>
  );
}

export default function SetPasswordPage() {
  return (
    <Suspense>
      <SetPasswordInner />
    </Suspense>
  );
}
