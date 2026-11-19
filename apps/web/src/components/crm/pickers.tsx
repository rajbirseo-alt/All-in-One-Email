'use client';

import { useEffect, useState } from 'react';
import type { CompanyView, ContactListItem } from '@crm/shared';
import { api } from '@/lib/api';
import { Input } from '@/components/ui';

function useDebounced<T>(value: T, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Search-as-you-type over the contacts the caller can see. */
export function ContactPicker({ id, value, onChange, exclude = [] }: { id: string; value: ContactListItem | null; onChange: (c: ContactListItem | null) => void; exclude?: string[] }) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [results, setResults] = useState<ContactListItem[]>([]);
  useEffect(() => {
    if (!dq.trim()) return setResults([]);
    let live = true;
    void api<{ items: ContactListItem[] }>('/contacts', { query: { q: dq, limit: 8 } }).then((r) => live && setResults(r.items.filter((c) => !exclude.includes(c.id))));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dq]);
  if (value)
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-1.5">
        <span className="min-w-0 truncate">
          {value.name ?? value.primaryEmail} <span className="text-text-3">{value.name ? value.primaryEmail : ''}</span>
        </span>
        <button type="button" className="text-[12px] text-text-3 underline" onClick={() => onChange(null)}>
          Change
        </button>
      </div>
    );
  return (
    <div className="relative">
      <Input id={id} placeholder="Search by name, email or company" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
      {results.length > 0 && (
        <ul className="absolute z-10 mt-1 max-h-60 w-full overflow-y-auto rounded-md border border-border bg-surface shadow-lg" role="listbox">
          {results.map((c) => (
            <li key={c.id}>
              <button type="button" className="w-full px-3 py-1.5 text-left hover:bg-surface-2" onClick={() => (onChange(c), setQ(''), setResults([]))}>
                {c.name ?? c.primaryEmail} <span className="text-[12.5px] text-text-3">{[c.name ? c.primaryEmail : null, c.company?.name].filter(Boolean).join(' · ')}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Company search with "none". */
export function CompanyPicker({ id, value, onChange }: { id: string; value: { id: string; name: string } | null; onChange: (c: { id: string; name: string } | null) => void }) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [results, setResults] = useState<CompanyView[]>([]);
  useEffect(() => {
    if (!dq.trim()) return setResults([]);
    let live = true;
    void api<CompanyView[]>('/companies', { query: { q: dq, limit: 8 } }).then((r) => live && setResults(r));
    return () => {
      live = false;
    };
  }, [dq]);
  if (value)
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-1.5">
        <span className="truncate">{value.name}</span>
        <button type="button" className="text-[12px] text-text-3 underline" onClick={() => onChange(null)}>
          Remove
        </button>
      </div>
    );
  return (
    <div className="relative">
      <Input id={id} placeholder="Search companies" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
      {results.length > 0 && (
        <ul className="absolute z-10 mt-1 max-h-60 w-full overflow-y-auto rounded-md border border-border bg-surface shadow-lg" role="listbox">
          {results.map((c) => (
            <li key={c.id}>
              <button type="button" className="w-full px-3 py-1.5 text-left hover:bg-surface-2" onClick={() => (onChange(c), setQ(''), setResults([]))}>
                {c.name} <span className="text-[12.5px] text-text-3">{c.domain}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
