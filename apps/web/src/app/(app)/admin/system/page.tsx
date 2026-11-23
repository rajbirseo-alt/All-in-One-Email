'use client';

import type { SystemHealth } from '@crm/shared';
import { api } from '@/lib/api';
import { useLoad } from '@/lib/hooks';
import { Badge, Button, Card, ErrorBanner, PageHeader, formatDate } from '@/components/ui';

const TONE = { ok: 'success', warn: 'warning', fail: 'danger' } as const;
const LABEL = { ok: '✓ OK', warn: '! Warning', fail: '✕ Failing' } as const;

/** Admin → System health: the same checks that alert administrators every 5 minutes. */
export default function SystemHealthPage() {
  const h = useLoad(() => api<SystemHealth>('/system/health'), []);
  return (
    <>
      <PageHeader
        title="System health"
        description="Mail sync, sending, background jobs, reports, virus scanning and storage. Administrators get a notification when a check fails and when it recovers."
        actions={
          <Button onClick={() => void h.reload()} pending={h.loading}>
            Check again
          </Button>
        }
      />
      <ErrorBanner error={h.error} />
      {h.data && (
        <>
          <p className="mb-3 text-[12px] text-text-3">
            Overall: <Badge tone={TONE[h.data.status]}>{LABEL[h.data.status]}</Badge> · checked {formatDate(h.data.checkedAt)}
          </p>
          <Card>
            <ul className="divide-y divide-border">
              {h.data.checks.map((c) => (
                <li key={c.key} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <span className="w-44 shrink-0 font-medium">{c.label}</span>
                  <span className="min-w-0 flex-1 text-text-2">{c.detail}</span>
                  <Badge tone={TONE[c.status]}>{LABEL[c.status]}</Badge>
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}
    </>
  );
}
