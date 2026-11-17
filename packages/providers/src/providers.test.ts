import { describe, expect, it } from 'vitest';
import { AuthError, CursorExpiredError, ProviderRequestError, RateLimitedError, TransientError } from './errors';
import { normalizeGmailMessage, type GmailRawMessage } from './gmail';
import { normalizeGraphMessage } from './graph';
import { ProviderHttp, mapError } from './http';
import { decodeEncodedWords, normalizeSubject, parseAddressList } from './message-utils';

const b64 = (s: string, enc: BufferEncoding = 'utf8') => Buffer.from(s, enc).toString('base64url');

describe('address and header parsing', () => {
  it('parses quoted names with commas, bare addresses and groups', () => {
    expect(parseAddressList('"Doe, Jane" <Jane@Example.com>, bob@x.org, Team: c@y.io, d@z.io;')).toEqual([
      { address: 'jane@example.com', name: 'Doe, Jane' },
      { address: 'bob@x.org', name: null },
      { address: 'c@y.io', name: null },
      { address: 'd@z.io', name: null },
    ]);
    expect(parseAddressList('undisclosed-recipients:;')).toEqual([]);
  });

  it('decodes RFC 2047 encoded words in B and Q forms', () => {
    expect(decodeEncodedWords('=?UTF-8?B?4KSo4KSu4KS44KWN4KSk4KWH?=')).toBe('नमस्ते');
    expect(decodeEncodedWords('=?ISO-8859-1?Q?Caf=E9_cr=E8me?=')).toBe('Café crème');
    expect(decodeEncodedWords('=?UTF-8?Q?a?= =?UTF-8?Q?b?=')).toBe('ab');
    expect(parseAddressList('=?UTF-8?B?UmFtw7Nu?= <r@x.com>')[0]!.name).toBe('Ramón');
  });

  it('normalises reply/forward prefixes for thread grouping', () => {
    expect(normalizeSubject('Re: FW: RE[2]: Quote for SEO')).toBe('quote for seo');
    expect(normalizeSubject('[Ticket 12] Help')).toBe('[ticket 12] help');
  });
});

describe('Gmail message normalisation', () => {
  const raw: GmailRawMessage = {
    id: 'm1',
    threadId: 't1',
    labelIds: ['INBOX', 'UNREAD', 'Label_7'],
    snippet: 'Hi &amp; welcome &#39;team&#39;',
    sizeEstimate: 2048,
    internalDate: '1763300000000',
    payload: {
      mimeType: 'multipart/mixed',
      headers: [
        { name: 'From', value: 'Client <client@acme.com>' },
        { name: 'To', value: 'sales@seodiscovery.com' },
        { name: 'Subject', value: '=?UTF-8?Q?Pr=C3=A9cis?=' },
        { name: 'Message-ID', value: '<abc@acme.com>' },
        { name: 'In-Reply-To', value: '<prev@seodiscovery.com>' },
        { name: 'References', value: '<root@x> <prev@seodiscovery.com>' },
        { name: 'Date', value: 'Sun, 16 Nov 2025 10:00:00 +0000' },
      ],
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [
            { mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset="iso-8859-1"' }], body: { data: b64('Caf\xe9', 'latin1') } },
            { mimeType: 'text/html', headers: [{ name: 'Content-Type', value: 'text/html; charset=UTF-8' }], body: { data: b64('<p>Café</p>') } },
          ],
        },
        {
          mimeType: 'application/pdf',
          filename: 'quote.pdf',
          headers: [{ name: 'Content-Disposition', value: 'attachment; filename="quote.pdf"' }],
          body: { attachmentId: 'att1', size: 1234 },
        },
        {
          mimeType: 'image/png',
          filename: 'logo.png',
          headers: [
            { name: 'Content-Disposition', value: 'inline' },
            { name: 'Content-ID', value: '<logo@x>' },
          ],
          body: { attachmentId: 'att2', size: 99 },
        },
      ],
    },
  };

  it('extracts headers, bodies in their charsets, flags and attachments', () => {
    const m = normalizeGmailMessage(raw);
    expect(m).toMatchObject({
      providerMessageId: 'm1',
      providerThreadId: 't1',
      internetMessageId: '<abc@acme.com>',
      inReplyTo: '<prev@seodiscovery.com>',
      references: ['<root@x>', '<prev@seodiscovery.com>'],
      from: { address: 'client@acme.com', name: 'Client' },
      to: [{ address: 'sales@seodiscovery.com', name: null }],
      subject: 'Précis',
      snippet: "Hi & welcome 'team'",
      bodyText: 'Café',
      bodyHtml: '<p>Café</p>',
      isRead: false,
      isStarred: false,
      providerFolderIds: ['INBOX', 'UNREAD', 'Label_7'],
      hasAttachments: true,
    });
    expect(m.receivedAt.toISOString()).toBe(new Date(1763300000000).toISOString());
    expect(m.attachments).toEqual([
      { providerAttachmentId: 'att1', filename: 'quote.pdf', contentType: 'application/pdf', sizeBytes: 1234, contentId: null, isInline: false },
      { providerAttachmentId: 'att2', filename: 'logo.png', contentType: 'image/png', sizeBytes: 99, contentId: 'logo@x', isInline: true },
    ]);
  });
});

describe('Graph message normalisation', () => {
  it('maps recipients, body type, flag and folder', () => {
    const m = normalizeGraphMessage({
      id: 'g1',
      conversationId: 'c1',
      internetMessageId: '<x@outlook.com>',
      subject: 'Hello',
      bodyPreview: 'Hi',
      body: { contentType: 'html', content: '<b>Hi</b>' },
      from: { emailAddress: { name: 'A', address: 'A@Outlook.com' } },
      toRecipients: [{ emailAddress: { address: 'me@co.com' } }, { emailAddress: { name: 'no address' } }],
      receivedDateTime: '2026-11-17T05:00:00Z',
      isRead: true,
      hasAttachments: true,
      flag: { flagStatus: 'flagged' },
      parentFolderId: 'F1',
    });
    expect(m).toMatchObject({
      providerThreadId: 'c1',
      from: { address: 'a@outlook.com', name: 'A' },
      to: [{ address: 'me@co.com', name: null }],
      bodyHtml: '<b>Hi</b>',
      bodyText: null,
      isRead: true,
      isStarred: true,
      hasAttachments: true,
      attachments: [],
      providerFolderIds: ['F1'],
    });
  });
});

describe('provider error mapping', () => {
  it('classifies statuses for retry decisions', () => {
    expect(mapError(429, {}, '30')).toBeInstanceOf(RateLimitedError);
    expect((mapError(429, {}, '30') as RateLimitedError).retryAfterSeconds).toBe(30);
    expect(mapError(403, { error: { message: 'x', errors: [{ reason: 'userRateLimitExceeded' }] } }, null)).toBeInstanceOf(RateLimitedError);
    expect(mapError(403, { error: { message: 'x', errors: [{ reason: 'insufficientPermissions' }] } }, null)).toBeInstanceOf(AuthError);
    expect(mapError(403, { error: { code: 'ErrorAccessDenied', message: 'x' } }, null)).toBeInstanceOf(AuthError);
    expect(mapError(503, {}, null)).toBeInstanceOf(TransientError);
    expect(mapError(400, { error: { message: 'bad' } }, null)).toBeInstanceOf(ProviderRequestError);
    expect(new CursorExpiredError('x')).toBeInstanceOf(Error);
  });

  it('refreshes the token once on 401 and gives up with AuthError on a second 401', async () => {
    const forced: boolean[] = [];
    let calls = 0;
    const http = new ProviderHttp(
      async (force) => {
        forced.push(force);
        return force ? 'new' : 'old';
      },
      (async (_url: string, init: RequestInit) => {
        calls++;
        const auth = (init.headers as Record<string, string>).authorization;
        return new Response(auth === 'Bearer new' ? '{"ok":true}' : '{}', { status: auth === 'Bearer new' ? 200 : 401 });
      }) as typeof fetch,
    );
    expect((await http.json<{ ok: boolean }>('https://x')).body).toEqual({ ok: true });
    expect(forced).toEqual([false, true]);
    expect(calls).toBe(2);

    const dead = new ProviderHttp(async () => 't', (async () => new Response('{}', { status: 401 })) as typeof fetch);
    await expect(dead.json('https://x')).rejects.toBeInstanceOf(AuthError);
  });
});
