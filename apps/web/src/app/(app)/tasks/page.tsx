'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import type { TaskView } from '@crm/shared';
import { api } from '@/lib/api';
import { useLoad } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { Card, ErrorBanner, PageHeader } from '@/components/ui';
import { AddTask, TaskList } from '@/components/crm/tasks';

const VIEWS = [
  { key: 'mine', label: 'My tasks' },
  { key: 'created', label: 'Given by me' },
  { key: 'all', label: 'Everything I can see' },
] as const;
const STATUSES = [
  { key: 'OPEN', label: 'Open' },
  { key: 'DONE', label: 'Done' },
  { key: '', label: 'All' },
] as const;

export default function TasksPage() {
  return (
    <Suspense>
      <Tasks />
    </Suspense>
  );
}

function Tasks() {
  const { can, me } = useSession();
  const highlight = useSearchParams().get('task');
  const [view, setView] = useState<(typeof VIEWS)[number]['key']>('mine');
  const [status, setStatus] = useState<string>(highlight ? '' : 'OPEN');
  const tasks = useLoad(() => api<TaskView[]>('/tasks', { query: { view, status } }), [view, status]);
  const wide = me.permissions['task.read'] && me.permissions['task.read'] !== 'OWN';

  useEffect(() => {
    if (highlight && tasks.data) document.getElementById(`task-${highlight}`)?.scrollIntoView({ block: 'center' });
  }, [highlight, tasks.data]);

  const tab = (active: boolean) => `rounded-md px-2.5 py-1 text-[13px] ${active ? 'bg-accent-soft font-medium text-accent' : 'text-text-2 hover:bg-surface-2'}`;
  return (
    <>
      <PageHeader title="Tasks" description="Follow-ups and to-dos. You are reminded when one falls due." />
      <div className="mb-3 flex flex-wrap items-center gap-1">
        {VIEWS.filter((v) => v.key !== 'all' || wide).map((v) => (
          <button key={v.key} className={tab(view === v.key)} onClick={() => setView(v.key)} aria-pressed={view === v.key}>
            {v.label}
          </button>
        ))}
        <span className="mx-2 h-4 w-px bg-border" aria-hidden />
        {STATUSES.map((s) => (
          <button key={s.key} className={tab(status === s.key)} onClick={() => setStatus(s.key)} aria-pressed={status === s.key}>
            {s.label}
          </button>
        ))}
      </div>
      <ErrorBanner error={tasks.error} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Card className="px-4 py-2">
          <TaskList tasks={tasks.data ?? []} onChanged={() => void tasks.reload()} highlight={highlight} />
        </Card>
        {can('task.write') && (
          <Card className="h-fit p-4">
            <h2 className="mb-2 text-[13px] font-semibold tracking-wide text-text-3 uppercase">New task</h2>
            <AddTask link={{}} onAdded={() => void tasks.reload()} />
          </Card>
        )}
      </div>
    </>
  );
}
