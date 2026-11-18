'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Renders sanitised email HTML in a sandboxed iframe: no scripts may run (no `allow-scripts`),
 * links open in a new tab, and the email's CSS cannot affect the CRM page.
 * `allow-same-origin` is needed so inline images (attachment URLs) carry the session cookie and
 * so the frame height can be measured; without `allow-scripts` the content still cannot run code.
 */
export function MessageFrame({ html, dark }: { html: string; dark: boolean }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(120);
  const doc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank">
<style>
  html,body{margin:0;padding:0;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:${dark ? '#e6e6e6' : '#1f1f1f'};background:transparent;overflow-wrap:anywhere}
  img{max-width:100%;height:auto} img[data-blocked-src]{display:none}
  a{color:${dark ? '#8ab4ff' : '#1a56db'}} blockquote{margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex;color:inherit;opacity:.85}
  table{max-width:100%} pre{white-space:pre-wrap}
</style></head><body>${html}</body></html>`;

  useEffect(() => {
    const f = ref.current;
    if (!f) return;
    const measure = () => {
      const h = f.contentDocument?.documentElement?.scrollHeight;
      if (h) setHeight(Math.min(h + 8, 20000));
    };
    f.addEventListener('load', measure);
    const t = setInterval(measure, 500); // images loading late
    const stop = setTimeout(() => clearInterval(t), 5000);
    return () => {
      f.removeEventListener('load', measure);
      clearInterval(t);
      clearTimeout(stop);
    };
  }, [html]);

  return <iframe ref={ref} title="Email content" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" srcDoc={doc} className="w-full border-0" style={{ height }} />;
}
