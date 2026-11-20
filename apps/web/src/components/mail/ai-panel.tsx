'use client';

import { useState } from 'react';
import type { AiSuggestionView, DraftView, ThreadDetail, ThreadInsights } from '@crm/shared';
import { api, ApiError } from '@/lib/api';
import { AI_TONE_LABEL, CATEGORY_LABEL } from '@/lib/ai';
import { useLoad } from '@/lib/hooks';
import { relative } from '@/lib/mail';
import { Badge, Button, ErrorBanner, Input, Select } from '@/components/ui';

const h3 = 'mb-1 text-[12px] font-semibold tracking-wide text-text-3 uppercase';
const URGENCY_TONE: Record<string, 'neutral' | 'warning' | 'danger'> = { LOW: 'neutral', NORMAL: 'neutral', HIGH: 'warning', URGENT: 'danger' };

/**
 * AI assistant for one conversation: summary and classification, and reply suggestions. A
 * suggestion only becomes a draft when the employee chooses "Use as draft"; it is never sent
 * without them pressing Send.
 */
export function AiPanel({ thread, canReply, onDraft }: { thread: ThreadDetail; canReply: boolean; onDraft: (d: DraftView) => void }) {
  const ins = useLoad(() => api<ThreadInsights>(`/threads/${thread.id}/insights`), [thread.id, thread.version]);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<'refresh' | 'suggest' | 'use' | null>(null);
  const [tone, setTone] = useState('professional');
  const [instructions, setInstructions] = useState('');
  const [suggestion, setSuggestion] = useState<AiSuggestionView | null>(null);
  const d = ins.data;
  if (!d) return ins.error ? <ErrorBanner error={ins.error} /> : null;
  if (!d.available) return <p className="rounded-lg border border-border bg-surface p-3 text-[12.5px] text-text-3">AI assistant: {d.reason}.</p>;

  const run = async (kind: 'refresh' | 'suggest' | 'use', fn: () => Promise<unknown>) => {
    setBusy(kind);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-3 text-[13.5px]" aria-label="AI assistant">
      <ErrorBanner error={error} />
      <div>
        <div className="mb-1 flex items-center justify-between gap-2">
          <h3 className={h3}>AI summary</h3>
          <button className="text-[12px] text-text-3 underline disabled:opacity-50" disabled={busy === 'refresh'} onClick={() => void run('refresh', async () => ins.setData(await api<ThreadInsights>(`/threads/${thread.id}/insights/refresh`, { method: 'POST' })))}>
            {busy === 'refresh' ? 'Analysing…' : d.summary ? 'Refresh' : 'Analyse'}
          </button>
        </div>
        {d.summary ? (
          <>
            <p className="text-text-2">{d.summary}</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {d.category && <Badge tone="accent">{CATEGORY_LABEL[d.category] ?? d.category}</Badge>}
              {d.urgency && <Badge tone={URGENCY_TONE[d.urgency.level] ?? 'neutral'}>{d.urgency.level.toLowerCase()} urgency</Badge>}
              {d.sentiment && <Badge tone={d.sentiment === 'NEGATIVE' ? 'danger' : d.sentiment === 'POSITIVE' ? 'success' : 'neutral'}>{d.sentiment.toLowerCase()}</Badge>}
            </div>
            {d.urgency?.reason && d.urgency.level !== 'NORMAL' && d.urgency.level !== 'LOW' && <p className="mt-1 text-[12.5px] text-text-3">{d.urgency.reason}</p>}
            {d.lead?.isLead && (
              <p className="mt-1.5 text-[12.5px] text-success">
                Looks like a new sales lead ({Math.round(d.lead.confidence * 100)}%){d.lead.serviceInterest ? ` · ${d.lead.serviceInterest}` : ''}
              </p>
            )}
            {d.followUp?.needed && d.followUp.action && <p className="mt-1 text-[12.5px] text-text-2">Next step: {d.followUp.action}{d.followUp.inDays ? ` (within ${d.followUp.inDays} days)` : ''}</p>}
            <p className="mt-1 text-[11.5px] text-text-3">
              {d.stale ? 'New mail since this analysis. ' : ''}
              {d.analyzedAt ? `Analysed ${relative(new Date(d.analyzedAt).getTime() - Date.now())}` : ''} · AI can be wrong
            </p>
          </>
        ) : (
          <p className="text-text-3">Not analysed yet.</p>
        )}
      </div>

      {canReply && (
        <div>
          <h3 className={h3}>Suggest a reply</h3>
          {suggestion ? (
            <div className="flex flex-col gap-2">
              <p className="rounded-md bg-surface-2 p-2 text-[13px] whitespace-pre-wrap">{suggestion.content}</p>
              <p className="text-[11.5px] text-text-3">Check every detail. Words in [brackets] need filling in.</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  pending={busy === 'use'}
                  onClick={() =>
                    void run('use', async () => {
                      const draft = await api<DraftView>(`/ai/suggestions/${suggestion.id}/use`, { method: 'POST' });
                      setSuggestion(null);
                      onDraft(draft);
                    })
                  }
                >
                  Use as draft
                </Button>
                <Button size="sm" onClick={() => void run('suggest', async () => setSuggestion(await api<AiSuggestionView>('/ai/suggest-reply', { method: 'POST', body: { threadId: thread.id, tone, instructions: instructions || undefined } })))} pending={busy === 'suggest'}>
                  Try again
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void api(`/ai/suggestions/${suggestion.id}/discard`, { method: 'POST' }).finally(() => setSuggestion(null))}>
                  Discard
                </Button>
              </div>
            </div>
          ) : (
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void run('suggest', async () => setSuggestion(await api<AiSuggestionView>('/ai/suggest-reply', { method: 'POST', body: { threadId: thread.id, tone, instructions: instructions || undefined } })));
              }}
            >
              <div className="flex gap-2">
                <Select aria-label="Tone" value={tone} onChange={(e) => setTone(e.target.value)} className="h-8 w-40 text-[13px]">
                  {Object.entries(AI_TONE_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </Select>
                <Button size="sm" type="submit" pending={busy === 'suggest'}>
                  Suggest
                </Button>
              </div>
              <Input aria-label="Instructions" placeholder="Optional: e.g. offer a call on Monday" value={instructions} maxLength={500} onChange={(e) => setInstructions(e.target.value)} className="h-8 text-[13px]" />
            </form>
          )}
        </div>
      )}
    </section>
  );
}
