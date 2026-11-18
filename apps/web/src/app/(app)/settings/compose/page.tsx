'use client';

import { useState } from 'react';
import type { SignatureView, TemplateView } from '@crm/shared';
import { api } from '@/lib/api';
import { useAction, useLoad } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { Badge, Button, Card, Empty, ErrorBanner, Field, Input, Modal, PageHeader, Select } from '@/components/ui';

type SigForm = { id: string | null; name: string; html: string; isDefault: boolean };
type TplForm = { id: string | null; name: string; subject: string; bodyHtml: string; sharing: TemplateView['sharing'] };

/** Signature/template bodies are edited as simple HTML; the server sanitises them on save. */
export default function ComposeSettingsPage() {
  const { can, me } = useSession();
  const sigs = useLoad(() => api<SignatureView[]>('/signatures'), []);
  const tpls = useLoad(() => api<TemplateView[]>('/templates'), []);
  const [sig, setSig] = useState<SigForm | null>(null);
  const [tpl, setTpl] = useState<TplForm | null>(null);

  const saveSig = useAction(async (f: SigForm) => {
    await api(f.id ? `/signatures/${f.id}` : '/signatures', { method: f.id ? 'PATCH' : 'POST', body: { name: f.name, html: f.html, isDefault: f.isDefault } });
    setSig(null);
    await sigs.reload();
  });
  const saveTpl = useAction(async (f: TplForm) => {
    await api(f.id ? `/templates/${f.id}` : '/templates', { method: f.id ? 'PATCH' : 'POST', body: { name: f.name, subject: f.subject || null, bodyHtml: f.bodyHtml, sharing: f.sharing } });
    setTpl(null);
    await tpls.reload();
  });
  const remove = useAction(async (path: string) => {
    if (!confirm('Delete it?')) return;
    await api(path, { method: 'DELETE' });
    await Promise.all([sigs.reload(), tpls.reload()]);
  });

  return (
    <>
      <PageHeader title="Signatures & templates" description="Your signature is added to new emails and replies. Templates can be inserted while writing." />
      <ErrorBanner error={sigs.error ?? tpls.error ?? remove.error} />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <div className="flex items-center justify-between border-b border-border p-4">
            <h2 className="text-[15px] font-semibold">Signatures</h2>
            <Button size="sm" onClick={() => setSig({ id: null, name: '', html: `<p>${me.user.name}<br>SEO Discovery</p>`, isDefault: !sigs.data?.length })}>
              New signature
            </Button>
          </div>
          {!sigs.data?.length ? (
            <Empty title="No signature yet" />
          ) : (
            <ul>
              {sigs.data.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5 last:border-0">
                  <span>
                    {s.name} {s.isDefault && <Badge tone="accent">Default</Badge>}
                  </span>
                  <span className="flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setSig({ id: s.id, name: s.name, html: s.html, isDefault: s.isDefault })}>
                      Edit
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void remove.run(`/signatures/${s.id}`)}>
                      Delete
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <div className="flex items-center justify-between border-b border-border p-4">
            <h2 className="text-[15px] font-semibold">Templates</h2>
            <Button size="sm" onClick={() => setTpl({ id: null, name: '', subject: '', bodyHtml: '', sharing: 'private' })}>
              New template
            </Button>
          </div>
          {!tpls.data?.length ? (
            <Empty title="No templates yet" />
          ) : (
            <ul>
              {tpls.data.map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5 last:border-0">
                  <span>
                    {t.name} <Badge>{t.sharing}</Badge> {t.owner.id !== me.user.id && <span className="text-[12px] text-text-3">by {t.owner.name}</span>}
                  </span>
                  {t.canEdit && (
                    <span className="flex gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setTpl({ id: t.id, name: t.name, subject: t.subject ?? '', bodyHtml: t.bodyHtml, sharing: t.sharing })}>
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void remove.run(`/templates/${t.id}`)}>
                        Delete
                      </Button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {sig && (
        <Modal
          open
          onClose={() => setSig(null)}
          title={sig.id ? 'Edit signature' : 'New signature'}
          footer={
            <>
              <Button onClick={() => setSig(null)}>Cancel</Button>
              <Button variant="primary" pending={saveSig.pending} onClick={() => void saveSig.run(sig)}>
                Save
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-3">
            <ErrorBanner error={saveSig.error} />
            <Field label="Name" htmlFor="s-name">
              <Input id="s-name" value={sig.name} onChange={(e) => setSig({ ...sig, name: e.target.value })} />
            </Field>
            <Field label="Signature (HTML)" htmlFor="s-html">
              <textarea id="s-html" rows={5} className="w-full rounded-md border border-border bg-surface p-2 font-mono text-[13px]" value={sig.html} onChange={(e) => setSig({ ...sig, html: e.target.value })} />
            </Field>
            <label className="flex items-center gap-2 text-[14px]">
              <input type="checkbox" checked={sig.isDefault} onChange={(e) => setSig({ ...sig, isDefault: e.target.checked })} /> Use by default
            </label>
          </div>
        </Modal>
      )}
      {tpl && (
        <Modal
          open
          wide
          onClose={() => setTpl(null)}
          title={tpl.id ? 'Edit template' : 'New template'}
          footer={
            <>
              <Button onClick={() => setTpl(null)}>Cancel</Button>
              <Button variant="primary" pending={saveTpl.pending} onClick={() => void saveTpl.run(tpl)}>
                Save
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-3">
            <ErrorBanner error={saveTpl.error} />
            <Field label="Name" htmlFor="t-name">
              <Input id="t-name" value={tpl.name} onChange={(e) => setTpl({ ...tpl, name: e.target.value })} />
            </Field>
            <Field label="Subject (optional)" htmlFor="t-subject">
              <Input id="t-subject" value={tpl.subject} onChange={(e) => setTpl({ ...tpl, subject: e.target.value })} />
            </Field>
            <Field label="Body (HTML)" htmlFor="t-body">
              <textarea id="t-body" rows={8} className="w-full rounded-md border border-border bg-surface p-2 font-mono text-[13px]" value={tpl.bodyHtml} onChange={(e) => setTpl({ ...tpl, bodyHtml: e.target.value })} />
            </Field>
            <Field label="Who can use it" htmlFor="t-share">
              <Select id="t-share" value={tpl.sharing} onChange={(e) => setTpl({ ...tpl, sharing: e.target.value as TplForm['sharing'] })}>
                <option value="private">Only me</option>
                {me.user.department && <option value="department">My department ({me.user.department.name})</option>}
                {can('conversation.read') && me.permissions['conversation.read'] === 'ALL' && <option value="company">Everyone</option>}
              </Select>
            </Field>
          </div>
        </Modal>
      )}
    </>
  );
}
