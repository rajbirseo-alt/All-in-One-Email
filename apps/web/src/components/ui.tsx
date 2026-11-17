'use client';

import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
const variants: Record<Variant, string> = {
  primary: 'bg-accent text-accent-text hover:bg-accent-hover border-transparent',
  secondary: 'bg-surface text-text border-border hover:bg-surface-2',
  ghost: 'bg-transparent text-text-2 border-transparent hover:bg-surface-2 hover:text-text',
  danger: 'bg-surface text-danger border-border hover:bg-danger-soft',
};

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; pending?: boolean; size?: 'sm' | 'md' }>(
  function Button({ variant = 'secondary', pending, size = 'md', className, children, disabled, ...rest }, ref) {
    return (
      <button
        ref={ref}
        className={cx(
          'inline-flex items-center justify-center gap-2 rounded-md border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-55',
          size === 'sm' ? 'h-7 px-2.5 text-[13px]' : 'h-9 px-3.5',
          variants[variant],
          className,
        )}
        disabled={disabled || pending}
        aria-busy={pending || undefined}
        {...rest}
      >
        {pending && <span className="size-3.5 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden />}
        {children}
      </button>
    );
  },
);

export function Field({ label, error, hint, children, htmlFor }: { label: string; error?: string; hint?: string; children: ReactNode; htmlFor: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-[13px] font-medium text-text">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-[12.5px] text-danger" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-[12.5px] text-text-3">{hint}</p>
      ) : null}
    </div>
  );
}

const control =
  'h-9 w-full rounded-md border border-border bg-surface px-3 text-text placeholder:text-text-3 focus:border-accent focus:outline-none aria-[invalid=true]:border-danger';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(function Input(
  { className, invalid, ...rest },
  ref,
) {
  return <input ref={ref} className={cx(control, className)} aria-invalid={invalid || undefined} {...rest} />;
});

export function Select({ className, invalid, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  return (
    <select className={cx(control, 'pr-8', className)} aria-invalid={invalid || undefined} {...rest}>
      {children}
    </select>
  );
}

type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
const tones: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-text-2',
  accent: 'bg-accent-soft text-accent',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
};

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={cx('inline-flex items-center rounded px-1.5 py-0.5 text-[12px] font-medium whitespace-nowrap', tones[tone])}>{children}</span>;
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('rounded-lg border border-border bg-surface', className)}>{children}</div>;
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-[20px] font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-0.5 text-text-2">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function ErrorBanner({ error }: { error?: { message: string } | null }) {
  if (!error) return null;
  return (
    <div role="alert" className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger">
      {error.message}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="px-4 py-12 text-center">
      <p className="font-medium">{title}</p>
      {children && <div className="mt-1 text-text-2">{children}</div>}
    </div>
  );
}

/** Native <dialog> modal: focus trap, Esc to close, accessible by default. */
export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      className={cx('m-auto w-[calc(100%-32px)] rounded-lg border border-border bg-surface p-0 text-text shadow-xl', wide ? 'max-w-2xl' : 'max-w-md')}
    >
      {open && (
        <div className="flex max-h-[85vh] flex-col">
          <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
            <h2 id={titleId} className="text-[15px] font-semibold">
              {title}
            </h2>
            <button onClick={onClose} className="rounded p-1 text-text-3 hover:bg-surface-2 hover:text-text" aria-label="Close">
              ✕
            </button>
          </div>
          <div className="overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-border text-[12px] font-medium tracking-wide text-text-3 uppercase">
            {head.map((h, i) => (
              <th key={i} className="px-4 py-2.5 font-medium whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="[&>tr]:border-b [&>tr]:border-border [&>tr:last-child]:border-0">{children}</tbody>
      </table>
    </div>
  );
}

export const Td = ({ children, className }: { children?: ReactNode; className?: string }) => <td className={cx('px-4 py-2.5 align-middle', className)}>{children}</td>;

export function formatDate(iso: string | null | undefined) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}
