import type { Address } from './types';

/** Decodes RFC 2047 encoded words (`=?UTF-8?B?...?=`, `=?ISO-8859-1?Q?...?=`) in a header value. */
export function decodeEncodedWords(value: string): string {
  // Whitespace between two adjacent encoded words is not part of the text (RFC 2047 §6.2).
  const joined = value.replace(/(=\?[^?]+\?[bBqQ]\?[^?]*\?=)\s+(?==\?[^?]+\?[bBqQ]\?[^?]*\?=)/g, '$1');
  return joined.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (whole, charset: string, enc: string, text: string) => {
    try {
      const bytes =
        enc.toUpperCase() === 'B'
          ? Buffer.from(text, 'base64')
          : Buffer.from(
              text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))),
              'latin1',
            );
      return decodeBytes(bytes, charset);
    } catch {
      return whole;
    }
  });
}

/** Decodes bytes in the declared charset; unknown charsets fall back to UTF-8. */
export function decodeBytes(bytes: Uint8Array, charset: string | null | undefined): string {
  const label = (charset ?? 'utf-8').trim().replace(/^"|"$/g, '').toLowerCase();
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/**
 * Parses an address list header ("A <a@x>, \"B, Jr\" <b@y>, c@z"). Group syntax and comments
 * are tolerated. Entries without an @ are dropped.
 */
export function parseAddressList(raw: string | null | undefined): Address[] {
  if (!raw) return [];
  const value = decodeEncodedWords(raw);
  const parts: string[] = [];
  let cur = '';
  let quoted = false;
  let angle = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (ch === '\\' && quoted) {
      cur += ch + (value[i + 1] ?? '');
      i++;
      continue;
    }
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === '<') angle++;
    else if (!quoted && ch === '>') angle = Math.max(0, angle - 1);
    if (!quoted && angle === 0 && (ch === ',' || ch === ';')) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  parts.push(cur);

  const out: Address[] = [];
  for (let p of parts) {
    p = p.replace(/^[^:<"]*:/, '').trim(); // drop "Group name:" prefix
    if (!p) continue;
    const m = /^(.*)<([^>]+)>\s*$/.exec(p);
    let name: string | null = null;
    let address: string;
    if (m) {
      name = m[1]!.trim().replace(/^"(.*)"$/, '$1').replace(/\\(.)/g, '$1').trim() || null;
      address = m[2]!.trim();
    } else {
      address = p.replace(/\(.*?\)/g, '').trim();
    }
    if (!address.includes('@')) continue;
    out.push({ address: address.toLowerCase(), name });
  }
  return out;
}

/** "<a@b>" or "a@b" → "<a@b>"; null for empty. */
export function normalizeMessageId(raw: string | null | undefined): string | null {
  const v = raw?.trim();
  if (!v) return null;
  const m = /<[^>]+>/.exec(v);
  return m ? m[0] : `<${v.replace(/^<|>$/g, '')}>`;
}

export function parseReferences(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw.match(/<[^>]+>/g) ?? [];
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Decodes the HTML entities Gmail uses in snippets. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
    if (e[0] === '#') {
      const n = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[e.toLowerCase()] ?? whole;
  });
}

export function parseDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Strips "Re:", "Fwd:", "AW:" … prefixes for thread grouping and lowercases. */
export function normalizeSubject(subject: string): string {
  let s = subject.trim();
  for (;;) {
    const next = s.replace(/^\s*((re|fw|fwd|aw|wg|sv|vs|antw|rif|r)\s*(\[\d+\])?\s*:\s*)/i, '');
    if (next === s) break;
    s = next;
  }
  return s.trim().toLowerCase();
}
