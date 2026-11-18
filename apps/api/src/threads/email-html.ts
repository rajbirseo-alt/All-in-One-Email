import sanitizeHtml from 'sanitize-html';

/**
 * Email HTML is hostile input. It is sanitised here (allow-list of tags, attributes and CSS
 * properties; no scripts, forms, frames, event handlers or `<style>` blocks), and the web app
 * additionally renders it in a sandboxed iframe without script permission.
 *
 * Remote images are blocked by default (they are commonly tracking pixels): their URL moves to
 * `data-blocked-src` until the reader chooses to load images. `cid:` references to inline
 * attachments are rewritten to the attachment endpoint.
 */
const SAFE_STYLE = /^[\w\s#%.,()'"!/-]*$/;
const styleProps = [
  'color',
  'background-color',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'text-align',
  'text-decoration',
  'line-height',
  'vertical-align',
  'white-space',
  'margin',
  'margin-top',
  'margin-bottom',
  'margin-left',
  'margin-right',
  'padding',
  'padding-top',
  'padding-bottom',
  'padding-left',
  'padding-right',
  'border',
  'border-top',
  'border-bottom',
  'border-left',
  'border-right',
  'border-collapse',
  'border-color',
  'border-width',
  'border-style',
  'border-radius',
  'width',
  'max-width',
  'min-width',
  'height',
  'display',
];

export interface SanitizedHtml {
  html: string;
  blockedImages: number;
}

export function sanitizeEmailHtml(raw: string, opts: { cidUrl: (cid: string) => string | null; loadRemoteImages: boolean }): SanitizedHtml {
  let blockedImages = 0;
  const html = sanitizeHtml(raw, {
    allowedTags: [
      ...sanitizeHtml.defaults.allowedTags,
      'img',
      'font',
      'center',
      'span',
      'div',
      'table',
      'thead',
      'tbody',
      'tfoot',
      'tr',
      'td',
      'th',
      'colgroup',
      'col',
      'caption',
      'u',
      's',
      'strike',
      'sup',
      'sub',
      'hr',
      'br',
    ],
    allowedAttributes: {
      '*': ['style', 'align', 'valign', 'width', 'height', 'dir', 'title', 'bgcolor'],
      a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'alt', 'data-blocked-src', 'border'],
      font: ['color', 'face', 'size'],
      td: ['colspan', 'rowspan', 'nowrap'],
      th: ['colspan', 'rowspan', 'nowrap'],
      table: ['cellpadding', 'cellspacing', 'border'],
    },
    allowedStyles: { '*': Object.fromEntries(styleProps.map((p) => [p, [SAFE_STYLE]])) },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['https', 'http', 'data', 'cid'] },
    allowProtocolRelative: false,
    // Text of dropped elements such as <style>/<script>/<title> must not leak into the body.
    nonTextTags: ['style', 'script', 'textarea', 'option', 'noscript', 'title', 'head'],
    transformTags: {
      a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer nofollow' } }),
      img: (tagName, attribs) => {
        const src = attribs.src ?? '';
        const out = { ...attribs };
        delete out.src;
        if (src.toLowerCase().startsWith('cid:')) {
          const url = opts.cidUrl(src.slice(4).replace(/^<|>$/g, ''));
          if (url) out.src = url;
        } else if (/^data:image\/(png|jpe?g|gif|webp);/i.test(src)) {
          out.src = src;
        } else if (/^https?:/i.test(src)) {
          if (opts.loadRemoteImages) out.src = src;
          else {
            out['data-blocked-src'] = src;
            blockedImages++;
          }
        }
        return { tagName, attribs: out };
      },
    },
  });
  return { html, blockedImages };
}

/** Plain text → minimal safe HTML (for text-only messages). */
export function textToHtml(text: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const linked = escaped.replace(/\bhttps?:\/\/[^\s<]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer nofollow">${u}</a>`);
  return `<div style="white-space: pre-wrap">${linked}</div>`;
}
