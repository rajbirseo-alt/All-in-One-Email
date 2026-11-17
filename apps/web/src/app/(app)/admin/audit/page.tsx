'use client';

import { useState } from 'react';
import type { AuditEntry, Page } from '@crm/shared';
import { api } from '@/lib/api';
import { useAction, useLoad } from '@/lib/hooks';
import { Badge, Button, Card, Empty, ErrorBanner, Input, Modal, PageHeader, Select, Table, Td, formatDate } from '@/components/ui';

const ENTITY_TYPES = ['user', 'session', 'role', 'department', 'team'];

export default function AuditPage() {
  const [action, setAction] = useState('');
  const [entityType, setEntityType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [open, setOpen] = useState<AuditEntry | null>(null);

  const query = { action, entityType, from: from ? new Date(from).toISOString() : '', to: to ? new Date(`${to}T23:59:59`).toISOString() : '', limit: 50 };
  const list = useLoad(async () => {
    const p = await api<Page<AuditEntry>>('/audit-logs', { query });
    setRows(p.items);
    setCursor(p.nextCursor);
    return p;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action, entityType, from, to]);
  const more = useAction(async () => {
    const p = await api<Page<AuditEntry>>('/audit-logs', { query: { ...query, cursor } });
    setRows((r) => [...r, ...p.items]);
    setCursor(p.nextCursor);
  });

  return (
    <>
      <PageHeader title="Audit log" description="Every sign-in and administrative change. Entries cannot be edited or deleted." />
      <Card>
        <div className="flex flex-wrap gap-2 border-b border-border p-3">
          <Input placeholder="Action starts with… e.g. user." value={action} onChange={(e) => setAction(e.target.value)} className="w-full sm:w-60" aria-label="Filter by action" />
          <Select value={entityType} onChange={(e) => setEntityType(e.target.value)} className="w-auto" aria-label="Filter by record type">
            <option value="">All record types</option>
            {ENTITY_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-auto" aria-label="From date" />
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-auto" aria-label="To date" />
        </div>
        <ErrorBanner error={list.error ?? more.error} />
        {list.loading && !rows.length ? (
          <p className="p-6 text-text-3">Loading…</p>
        ) : !rows.length ? (
          <Empty title="No entries match" />
        ) : (
          <Table head={['When', 'Who', 'Action', 'Record', 'IP', '']}>
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-surface-2/60">
                <Td className="text-[12.5px] whitespace-nowrap text-text-2">{formatDate(r.createdAt)}</Td>
                <Td>{r.actor?.name ?? <Badge>{r.actorType.toLowerCase()}</Badge>}</Td>
                <Td>
                  <code className="font-mono text-[12.5px]">{r.action}</code>
                </Td>
                <Td className="text-[12.5px] text-text-2">
                  {r.entityType}
                  {r.entityId && <span className="ml-1 font-mono text-text-3">{r.entityId.slice(-8)}</span>}
                </Td>
                <Td className="font-mono text-[12.5px] text-text-3">{r.ip ?? '—'}</Td>
                <Td className="text-right">
                  {(r.before != null || r.after != null || r.metadata != null) && (
                    <Button size="sm" variant="ghost" onClick={() => setOpen(r)}>
                      Details
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
        {cursor && (
          <div className="border-t border-border p-3 text-center">
            <Button size="sm" onClick={() => void more.run()} pending={more.pending}>
              Load more
            </Button>
          </div>
        )}
      </Card>
      {open && (
        <Modal open wide onClose={() => setOpen(null)} title={open.action}>
          <div className="grid gap-3 sm:grid-cols-2">
            {(['before', 'after'] as const).map((k) => (
              <div key={k}>
                <p className="mb-1 text-[12px] font-medium tracking-wide text-text-3 uppercase">{k}</p>
                <pre className="max-h-80 overflow-auto rounded-md bg-surface-2 p-3 text-[12px]">{open[k] == null ? '—' : JSON.stringify(open[k], null, 2)}</pre>
              </div>
            ))}
          </div>
          {open.metadata != null && (
            <div className="mt-3">
              <p className="mb-1 text-[12px] font-medium tracking-wide text-text-3 uppercase">details</p>
              <pre className="overflow-auto rounded-md bg-surface-2 p-3 text-[12px]">{JSON.stringify(open.metadata, null, 2)}</pre>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
