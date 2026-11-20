import { describe, expect, it } from 'vitest';
import { folderKind, imapFlagState, parseImapMessage, uidSet } from './imap';

describe('IMAP helpers', () => {
  it('maps folders by SPECIAL-USE first, then by name', () => {
    expect(folderKind({ path: 'INBOX', name: 'INBOX' })).toBe('INBOX');
    expect(folderKind({ path: 'Gesendet', name: 'Gesendet', specialUse: '\Sent' })).toBe('SENT');
    expect(folderKind({ path: 'INBOX.Sent Items', name: 'Sent Items' })).toBe('SENT');
    expect(folderKind({ path: 'Junk E-mail', name: 'Junk E-mail' })).toBe('SPAM');
    expect(folderKind({ path: 'Deleted Messages', name: 'Deleted Messages' })).toBe('TRASH');
    expect(folderKind({ path: 'Clients/Acme', name: 'Acme' })).toBe('CUSTOM');
  });

  it('compresses UID sets and reads flags with or without the backslash', () => {
    expect(uidSet([5, 1, 2, 3, 9, 10, 3])).toBe('1:3,5,9:10');
    expect(imapFlagState(new Set(['\Seen', 'Flagged']))).toEqual({ isRead: true, isStarred: true, isDeleted: false });
  });

  it('parses a message into the stored shape', async () => {
    const raw = Buffer.from(
      [
        'From: "Asha Rao" <Asha@Client.example>',
        'To: sales@x.test, Bob <bob@x.test>',
        'Reply-To: asha.private@client.example',
        'Subject: =?UTF-8?B?UXVvdGUg4pyT?=',
        'Message-ID: <abc@client.example>',
        'In-Reply-To: <prev@x.test>',
        'References: <first@x.test> <prev@x.test>',
        'Date: Tue, 17 Nov 2026 10:00:00 +0530',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Hello there',
      ].join('\r\n'),
    );
    const m = await parseImapMessage({ uid: 42, flags: new Set(['\Seen']), internalDate: new Date('2026-11-17T04:31:00Z'), source: raw }, 'INBOX', 7n);
    expect(m).toMatchObject({
      providerMessageId: 'mid:<abc@client.example>',
      internetMessageId: '<abc@client.example>',
      inReplyTo: '<prev@x.test>',
      references: ['<first@x.test>', '<prev@x.test>'],
      from: { address: 'asha@client.example', name: 'Asha Rao' },
      replyTo: [{ address: 'asha.private@client.example', name: null }],
      subject: 'Quote ✓',
      bodyText: 'Hello there',
      isRead: true,
      imapUid: 42,
      providerFolderIds: ['INBOX'],
    });
    expect(m.to.map((a) => a.address)).toEqual(['sales@x.test', 'bob@x.test']);
    const noId = await parseImapMessage({ uid: 3, flags: new Set(), internalDate: null, source: Buffer.from('Subject: x\r\n\r\nbody') }, 'Archive', 9n);
    expect(noId.providerMessageId).toBe('uid:9:3@Archive');
  });
});
