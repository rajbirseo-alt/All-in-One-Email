'use client';

import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { AuthProvidersResponse, LoginResponse } from '@crm/shared';
import { api, ApiError } from '@/lib/api';
import { Button, Field, Input } from '@/components/ui';
import { TotpSetup } from '@/components/totp-setup';

const SSO_ERRORS: Record<string, string> = {
  not_invited: 'This account has not been invited. Ask an administrator to add you.',
  domain_not_allowed: 'Use your company account, a Gmail address, or a personal Outlook/Hotmail/Live address that an administrator invited.',
  tenant_not_allowed: 'Accounts from other organisations cannot sign in. Use your company or personal Microsoft account.',
  account_suspended: 'Your account is suspended. Contact an administrator.',
  identity_mismatch: 'A different account from this provider is already linked to you. Contact an administrator.',
  email_unverified: 'Your email address is not verified with the provider.',
  cancelled: 'Sign-in was cancelled.',
  invalid_state: 'Your sign-in session expired. Please try again.',
};

type Step = { kind: 'password' } | { kind: 'verify'; mfaToken: string } | { kind: 'enroll'; mfaToken: string; secret?: string; otpauthUri?: string };

function LoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const [providers, setProviders] = useState<AuthProvidersResponse | null>(null);
  const [step, setStep] = useState<Step>({ kind: 'password' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(() => {
    const e = params.get('error');
    return e ? (SSO_ERRORS[e] ?? 'Sign-in failed. Please try again.') : null;
  });
  const [pending, setPending] = useState(false);

  useEffect(() => {
    api<AuthProvidersResponse>('/auth/providers').then(setProviders, () => setError('Could not reach the server.'));
    // Already signed in? Go straight in.
    api('/auth/me').then(() => router.replace('/'), () => undefined);
  }, [router]);

  async function handle(res: LoginResponse) {
    if (res.status === 'ok') router.replace('/');
    else if (res.status === 'mfa_required') setStep({ kind: 'verify', mfaToken: res.mfaToken });
    else {
      const setup = await api<{ secret: string; otpauthUri: string }>('/auth/mfa/enroll/start', { method: 'POST', body: { mfaToken: res.mfaToken } });
      setStep({ kind: 'enroll', mfaToken: res.mfaToken, ...setup });
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      if (step.kind === 'password') {
        await handle(await api<LoginResponse>('/auth/login', { method: 'POST', body: { email, password } }));
      } else {
        const path = step.kind === 'verify' ? '/auth/mfa/verify' : '/auth/mfa/enroll/confirm';
        await handle(await api<LoginResponse>(path, { method: 'POST', body: { mfaToken: step.mfaToken, code } }));
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
      if (err instanceof ApiError && err.code === 'MFA_TOKEN_INVALID') setStep({ kind: 'password' });
      setCode('');
    } finally {
      setPending(false);
    }
  }

  const sso = providers && (providers.google || providers.microsoft);

  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-[380px]">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 grid size-10 place-items-center rounded-lg bg-accent text-[17px] font-bold text-accent-text">S</div>
          <h1 className="text-[20px] font-semibold tracking-tight">Sign in to SEO Discovery CRM</h1>
        </div>
        <div className="rounded-lg border border-border bg-surface p-6 shadow-sm">
          {error && (
            <div role="alert" className="mb-4 rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger">
              {error}
            </div>
          )}

          {step.kind === 'password' && (
            <>
              {sso && (
                <div className="flex flex-col gap-2">
                  {providers.google && (
                    <a href="/api/v1/auth/sso/google/start" className="flex h-10 items-center justify-center gap-2 rounded-md border border-border font-medium hover:bg-surface-2">
                      <GoogleMark /> Continue with Google
                    </a>
                  )}
                  {providers.microsoft && (
                    <a href="/api/v1/auth/sso/microsoft/start" className="flex h-10 items-center justify-center gap-2 rounded-md border border-border font-medium hover:bg-surface-2">
                      <MicrosoftMark /> Continue with Microsoft
                    </a>
                  )}
                </div>
              )}
              {sso && providers.password && (
                <div className="my-5 flex items-center gap-3 text-[12px] text-text-3">
                  <span className="h-px flex-1 bg-border" />
                  or
                  <span className="h-px flex-1 bg-border" />
                </div>
              )}
              {providers?.password && (
                <form onSubmit={submit} className="flex flex-col gap-4">
                  <Field label="Work email" htmlFor="email">
                    <Input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
                  </Field>
                  <Field label="Password" htmlFor="password">
                    <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
                  </Field>
                  <Button variant="primary" type="submit" pending={pending} className="h-10">
                    Sign in
                  </Button>
                </form>
              )}
              {providers && !sso && !providers.password && <p className="text-text-2">No sign-in method is configured. Contact your administrator.</p>}
            </>
          )}

          {step.kind !== 'password' && (
            <form onSubmit={submit} className="flex flex-col gap-4">
              {step.kind === 'enroll' ? (
                <>
                  <div>
                    <p className="font-medium">Set up two-factor authentication</p>
                    <p className="mt-1 text-[13px] text-text-2">Your role requires an authenticator app. Scan the code, then enter the 6-digit code it shows.</p>
                  </div>
                  {step.secret && step.otpauthUri && <TotpSetup secret={step.secret} otpauthUri={step.otpauthUri} />}
                </>
              ) : (
                <p className="text-text-2">Enter the 6-digit code from your authenticator app.</p>
              )}
              <Field label="Authentication code" htmlFor="code">
                <Input
                  id="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="\d{6}"
                  maxLength={6}
                  required
                  autoFocus
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  className="text-center font-mono text-[16px] tracking-[0.4em]"
                />
              </Field>
              <Button variant="primary" type="submit" pending={pending} className="h-10">
                {step.kind === 'enroll' ? 'Turn on and sign in' : 'Verify'}
              </Button>
              <button type="button" className="text-[13px] text-text-2 hover:text-text" onClick={() => { setStep({ kind: 'password' }); setCode(''); }}>
                Back
              </button>
            </form>
          )}
        </div>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginInner />
    </Suspense>
  );
}

function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

function MicrosoftMark() {
  return (
    <svg width="15" height="15" viewBox="0 0 23 23" aria-hidden>
      <path fill="#f35325" d="M1 1h10v10H1z" />
      <path fill="#81bc06" d="M12 1h10v10H12z" />
      <path fill="#05a6f0" d="M1 12h10v10H1z" />
      <path fill="#ffba08" d="M12 12h10v10H12z" />
    </svg>
  );
}
