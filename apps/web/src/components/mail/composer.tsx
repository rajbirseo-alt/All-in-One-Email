'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DraftView, TemplateView, ThreadChangedDetails } from '@crm/shared';
import { api, ApiError } from '@/lib/api';
import { useLoad } from '@/lib/hooks';
import { formatAddresses, formatBytes, parseAddresses, shortDate, who } from '@/lib/mail';
import { Button, ErrorBanner, Input, Select } from '@/components/ui';
import { AI_TONE_LABEL, useAiStatus } from '@/lib/ai';
import { useSession } from '@/lib/session';

const MODE_LABEL = { NEW: 'New email', REPLY: 'Reply', REPLY_ALL: 'Reply all', FORWARD: 'Forward' } as const;

/** The part of the editor the employee wrote: everything before the signature and the quoted mail. */
function ownNodes(root: HTMLElement): ChildNode[] {
  const out: ChildNode[] = [];
  for (const n of Array.from(root.childNodes)) {
    if (n instanceof HTMLElement && (n.classList.contains('crm-signature') || n.classList.contains('crm-quote'))) break;
    out.push(n);
  }
  return out;
}

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const paragraphs = (t: string) => t.trim().split(/\n{2,}/).map((x) => `<p>${esc(x).replace(/\n/g, '<br>')}</p>`).join('');

export function Composer({ initial, onClose, onSent }: { initial: DraftView; onClose: () => void; onSent: () => void }) {
  const [draft, setDraft] = useState(initial);
  const [to, setTo] = useState(formatAddresses(initial.to));
  const [cc, setCc] = useState(formatAddresses(initial.cc));
  const [bcc, setBcc] = useState(formatAddresses(initial.bcc));
  const [showCc, setShowCc] = useState(initial.cc.length > 0 || initial.bcc.length > 0);
  const [subject, setSubject] = useState(initial.subject);
  const [scheduleAt, setScheduleAt] = useState('');
  const [saveState, setSaveState] = useState<'saved' | 'dirty' | 'saving'>('saved');
  const [error, setError] = useState<ApiError | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [changed, setChanged] = useState<ThreadChangedDetails | null>(null);
  const [sending, setSending] = useState(false);
  const editor = useRef<HTMLDivElement>(null);
  const ai = useAiStatus();
  const { can } = useSession();
  const [rewrite, setRewrite] = useState<{ text: string; label: string } | null>(null);
  const [rewriting, setRewriting] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const templates = useLoad(() => api<TemplateView[]>('/templates'), []);

  useEffect(() => {
    if (editor.current) editor.current.innerHTML = initial.bodyHtml;
  }, [initial.bodyHtml]);

  const save = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    const parsed = [parseAddresses(to), parseAddresses(cc), parseAddresses(bcc)];
    const bad = parsed.flatMap((p) => p.invalid);
    if (bad.length) {
      setFieldError(`Not an email address: ${bad.join(', ')}`);
      return false;
    }
    setFieldError(null);
    setSaveState('saving');
    try {
      const d = await api<DraftView>(`/drafts/${draft.id}`, {
        method: 'PATCH',
        body: { to: parsed[0]!.list, cc: parsed[1]!.list, bcc: parsed[2]!.list, subject, bodyHtml: editor.current?.innerHTML ?? '' },
      });
      setDraft(d);
      setSaveState('saved');
      return true;
    } catch (e) {
      setError(e as ApiError);
      setSaveState('dirty');
      return false;
    }
  }, [draft.id, to, cc, bcc, subject]);

  const touched = () => {
    setSaveState('dirty');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), 1200);
  };
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  /** AI grammar / tone help on the employee's own text. The result is shown first; nothing changes until they accept it. */
  const improve = async (choice: string) => {
    if (!editor.current || !choice) return;
    const text = ownNodes(editor.current)
      .map((n) => (n instanceof HTMLElement ? n.innerText : (n.textContent ?? '')))
      .join('\n\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (!text) return setError(new ApiError(0, 'EMPTY', 'Write something first, then ask the AI to improve it'));
    setRewriting(true);
    setError(null);
    try {
      const body = choice === 'grammar' ? { draftId: draft.id, text, kind: 'grammar' } : { draftId: draft.id, text, kind: 'tone', tone: choice };
      const r = await api<{ text: string }>('/ai/rewrite', { method: 'POST', body });
      setRewrite({ text: r.text, label: choice === 'grammar' ? 'Grammar and spelling fixed' : `Rewritten: ${AI_TONE_LABEL[choice] ?? choice}` });
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setRewriting(false);
    }
  };
  const acceptRewrite = () => {
    if (!editor.current || !rewrite) return;
    const own = ownNodes(editor.current);
    const holder = document.createElement('div');
    holder.innerHTML = paragraphs(rewrite.text);
    const anchor = own.length ? own[own.length - 1]!.nextSibling : editor.current.firstChild;
    for (const n of own) n.remove();
    for (const n of Array.from(holder.childNodes)) editor.current.insertBefore(n, anchor);
    setRewrite(null);
    touched();
  };

  const exec = (cmd: string, value?: string) => {
    editor.current?.focus();
    document.execCommand(cmd, false, value);
    touched();
  };

  const send = async (baseThreadVersion?: number) => {
    setError(null);
    if (!(await save())) return;
    setSending(true);
    try {
      await api(`/drafts/${draft.id}/send`, {
        method: 'POST',
        body: { baseThreadVersion: baseThreadVersion ?? draft.baseThreadVersion ?? undefined, scheduledFor: scheduleAt ? new Date(scheduleAt).toISOString() : null },
      });
      onSent();
    } catch (e) {
      const err = e as ApiError;
      if (err.code === 'THREAD_CHANGED') setChanged(err.details as unknown as ThreadChangedDetails);
      else setError(err);
    } finally {
      setSending(false);
    }
  };

  const discard = async () => {
    if (!confirm('Discard this draft?')) return;
    await api(`/drafts/${draft.id}`, { method: 'DELETE' }).catch(() => undefined);
    onClose();
  };

  const upload = async (files: FileList | null) => {
    for (const file of Array.from(files ?? [])) {
      const form = new FormData();
      form.append('file', file);
      const csrf = document.cookie.match(/(?:^|;\s*)(?:__Host-)?crm_csrf=([^;]+)/)?.[1];
      const res = await fetch(`/api/v1/drafts/${draft.id}/attachments`, { method: 'POST', body: form, headers: csrf ? { 'x-csrf-token': decodeURIComponent(csrf) } : {} });
      const body = await res.json().catch(() => null);
      if (!res.ok) setError(new ApiError(res.status, body?.error?.code ?? 'ERROR', body?.error?.details?.[0]?.message ?? body?.error?.message ?? 'Upload failed'));
      else setDraft(body as DraftView);
    }
  };

  const removeAttachment = async (id: string) => setDraft(await api<DraftView>(`/drafts/${draft.id}/attachments/${id}`, { method: 'DELETE' }));

  const insertTemplate = (id: string) => {
    const t = templates.data?.find((x) => x.id === id);
    if (!t) return;
    if (t.subject && !subject.trim()) setSubject(t.subject);
    editor.current?.focus();
    // Templates are sanitised server-side when saved.
    document.execCommand('insertHTML', false, t.bodyHtml);
    touched();
  };

  return (
    <section className="flex flex-col rounded-lg border border-border bg-surface" aria-label={MODE_LABEL[draft.mode]}>
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <p className="text-[13px] font-semibold">
          {MODE_LABEL[draft.mode]} <span className="font-normal text-text-3">from {draft.emailAccount.emailAddress}</span>
        </p>
        <span className="text-[12px] text-text-3">{saveState === 'saved' ? 'Saved' : saveState === 'saving' ? 'Saving…' : 'Unsaved'}</span>
      </div>
      <div className="flex flex-col gap-1.5 border-b border-border px-3 py-2 text-[14px]">
        <label className="flex items-center gap-2">
          <span className="w-12 text-text-3">To</span>
          <Input value={to} onChange={(e) => (setTo(e.target.value), touched())} aria-label="To" className="h-8" />
          {!showCc && (
            <button type="button" className="text-[12px] whitespace-nowrap text-text-3 hover:text-text" onClick={() => setShowCc(true)}>
              Cc/Bcc
            </button>
          )}
        </label>
        {showCc && (
          <>
            <label className="flex items-center gap-2">
              <span className="w-12 text-text-3">Cc</span>
              <Input value={cc} onChange={(e) => (setCc(e.target.value), touched())} aria-label="Cc" className="h-8" />
            </label>
            <label className="flex items-center gap-2">
              <span className="w-12 text-text-3">Bcc</span>
              <Input value={bcc} onChange={(e) => (setBcc(e.target.value), touched())} aria-label="Bcc" className="h-8" />
            </label>
          </>
        )}
        <label className="flex items-center gap-2">
          <span className="w-12 text-text-3">Subject</span>
          <Input value={subject} onChange={(e) => (setSubject(e.target.value), touched())} aria-label="Subject" className="h-8" />
        </label>
        {fieldError && <p className="text-[12.5px] text-danger">{fieldError}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-1 border-b border-border px-2 py-1">
        {[
          ['bold', 'B', 'Bold'],
          ['italic', 'I', 'Italic'],
          ['underline', 'U', 'Underline'],
          ['insertUnorderedList', '•', 'Bulleted list'],
        ].map(([cmd, label, title]) => (
          <button key={cmd} type="button" title={title} aria-label={title} onClick={() => exec(cmd!)} className="min-w-7 rounded px-1.5 py-0.5 text-[13px] font-semibold text-text-2 hover:bg-surface-2">
            {label}
          </button>
        ))}
        <button
          type="button"
          className="rounded px-1.5 py-0.5 text-[13px] text-text-2 hover:bg-surface-2"
          onClick={() => {
            const url = prompt('Link address (https://…)');
            if (url && /^(https?:|mailto:)/i.test(url)) exec('createLink', url);
          }}
        >
          Link
        </button>
        {ai?.enabled && can('ai.use') && (
          <Select aria-label="Improve writing with AI" className="ml-auto h-7 w-44 text-[13px]" value="" disabled={rewriting} onChange={(e) => void improve(e.target.value)}>
            <option value="">{rewriting ? 'Improving…' : 'Improve writing…'}</option>
            <option value="grammar">Fix grammar and spelling</option>
            {Object.entries(AI_TONE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                Make it: {v.toLowerCase()}
              </option>
            ))}
          </Select>
        )}
        {!!templates.data?.length && (
          <Select aria-label="Insert template" className={`${ai?.enabled && can('ai.use') ? '' : 'ml-auto '}h-7 w-44 text-[13px]`} value="" onChange={(e) => insertTemplate(e.target.value)}>
            <option value="">Insert template…</option>
            {templates.data.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        )}
      </div>
      <div
        ref={editor}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label="Message"
        onInput={touched}
        onPaste={(e) => {
          // Plain text only: pasted HTML could carry scripts or tracking.
          e.preventDefault();
          document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
        }}
        className="max-h-[50vh] min-h-40 overflow-y-auto px-3 py-2 text-[14px] leading-relaxed outline-none [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-2 [&_blockquote]:text-text-2"
      />
      {rewrite && (
        <div className="border-t border-border bg-accent-soft px-3 py-2 text-[13px]" role="dialog" aria-label="AI suggestion">
          <p className="font-medium text-accent">{rewrite.label}. Replace your text with this?</p>
          <p className="my-1.5 rounded bg-surface p-2 whitespace-pre-wrap text-text">{rewrite.text}</p>
          <div className="flex gap-2">
            <Button size="sm" variant="primary" onClick={acceptRewrite}>
              Replace
            </Button>
            <Button size="sm" onClick={() => setRewrite(null)}>
              Keep mine
            </Button>
          </div>
        </div>
      )}
      {draft.attachments.length > 0 && (
        <ul className="flex flex-wrap gap-2 border-t border-border px-3 py-2">
          {draft.attachments.map((a) => (
            <li key={a.id} className="flex items-center gap-1.5 rounded border border-border px-2 py-1 text-[12.5px]">
              {a.filename} <span className="text-text-3">{formatBytes(a.sizeBytes)}</span>
              <button type="button" aria-label={`Remove ${a.filename}`} className="text-text-3 hover:text-danger" onClick={() => void removeAttachment(a.id)}>
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      {changed && (
        <div className="border-t border-border bg-warning-soft px-3 py-2 text-[13px] text-warning" role="alert">
          <p className="font-medium">New messages arrived while you were writing:</p>
          <ul className="my-1 list-disc pl-5">
            {changed.newMessages.map((m) => (
              <li key={m.id}>
                {who(m.from)} · {shortDate(m.receivedAt)} — {m.snippet}
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Button size="sm" variant="primary" onClick={() => void send(changed.currentVersion).then(() => setChanged(null))}>
              Send anyway
            </Button>
            <Button size="sm" onClick={() => setChanged(null)}>
              Keep editing
            </Button>
          </div>
        </div>
      )}
      <ErrorBanner error={error} />
      <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2">
        <Button variant="primary" pending={sending} onClick={() => void send()}>
          {scheduleAt ? 'Schedule' : 'Send'}
        </Button>
        <label className="cursor-pointer rounded-md px-2 py-1 text-[13px] text-text-2 hover:bg-surface-2">
          Attach
          <input type="file" multiple className="sr-only" onChange={(e) => void upload(e.target.files).then(() => (e.target.value = ''))} />
        </label>
        <label className="flex items-center gap-1 text-[12.5px] text-text-3">
          Send later
          <input type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} className="rounded border border-border bg-surface px-1 py-0.5 text-text" />
        </label>
        <div className="ml-auto flex gap-1">
          <Button size="sm" variant="ghost" onClick={() => void save().then((ok) => ok && onClose())}>
            Close
          </Button>
          <Button size="sm" variant="danger" onClick={() => void discard()}>
            Discard
          </Button>
        </div>
      </div>
    </section>
  );
}
