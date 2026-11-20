import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { SMTPServer } from 'smtp-server';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const hoodiecrow = require('hoodiecrow-imap') as (opts: object) => HoodieServer;

interface HoodieMessage {
  uid: number;
  raw: string;
  flags: string[];
  internaldate: string | Date;
}
interface HoodieMailbox {
  uidvalidity: number;
  uidnext: number;
  messages: HoodieMessage[];
}
interface HoodieServer {
  listen(port: number, cb: () => void): void;
  close(cb?: () => void): void;
  address(): AddressInfo;
  getMailbox(path: string): HoodieMailbox;
  appendMessage(mailbox: string, flags: string[], internaldate: Date, raw: string): { message: HoodieMessage };
  users: Record<string, { password: string }>;
}

export interface RawMail {
  from: string;
  to: string;
  subject: string;
  text?: string;
  messageId?: string | null;
  inReplyTo?: string;
  references?: string;
  date?: Date;
  replyTo?: string;
  cc?: string;
  attachment?: { filename: string; contentType: string; content: Buffer };
}

/** An RFC 5322 message, CRLF line endings. */
export function rawMail(m: RawMail): string {
  const h = [
    `From: ${m.from}`,
    `To: ${m.to}`,
    ...(m.cc ? [`Cc: ${m.cc}`] : []),
    `Subject: ${m.subject}`,
    ...(m.messageId === null ? [] : [`Message-ID: ${m.messageId ?? `<${Math.random().toString(36).slice(2)}@test.example>`}`]),
    ...(m.inReplyTo ? [`In-Reply-To: ${m.inReplyTo}`] : []),
    ...(m.references ? [`References: ${m.references}`] : []),
    ...(m.replyTo ? [`Reply-To: ${m.replyTo}`] : []),
    `Date: ${(m.date ?? new Date()).toUTCString()}`,
    'MIME-Version: 1.0',
  ];
  if (!m.attachment) return [...h, 'Content-Type: text/plain; charset=utf-8', '', m.text ?? 'Hello', ''].join('\r\n');
  const b = 'BOUNDARY42';
  return [
    ...h,
    `Content-Type: multipart/mixed; boundary="${b}"`,
    '',
    `--${b}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    m.text ?? 'See attached',
    `--${b}`,
    `Content-Type: ${m.attachment.contentType}; name="${m.attachment.filename}"`,
    `Content-Disposition: attachment; filename="${m.attachment.filename}"`,
    'Content-Transfer-Encoding: base64',
    '',
    m.attachment.content.toString('base64').replace(/.{76}/g, '$&\r\n'),
    `--${b}--`,
    '',
  ].join('\r\n');
}

export interface SmtpCapture {
  from: string;
  to: string[];
  raw: string;
}

/**
 * One mailbox on a local IMAP server (hoodiecrow, with IDLE, UIDPLUS, MOVE, SPECIAL-USE) plus a
 * local SMTP server that records what it is asked to send. Both speak plain TCP on 127.0.0.1.
 */
export class FakeImapBox {
  imap!: HoodieServer;
  smtp!: SMTPServer;
  imapPort = 0;
  smtpPort = 0;
  readonly sent: SmtpCapture[] = [];
  /** Make the SMTP server refuse the next N sends with a temporary error. */
  failNextSends = 0;

  constructor(
    readonly user: string,
    public password = 'right-password',
  ) {}

  async start(folders: Record<string, string> = { Sent: '\\Sent', Archive: '\\Archive', Junk: '\\Junk', Trash: '\\Trash', Drafts: '\\Drafts' }) {
    this.imap = hoodiecrow({
      plugins: ['ID', 'IDLE', 'ENABLE', 'CONDSTORE', 'LITERALPLUS', 'UNSELECT', 'SPECIAL-USE', 'UIDPLUS', 'MOVE', 'NAMESPACE', 'SASL-IR', 'AUTH-PLAIN'],
      users: { [this.user]: { password: this.password } },
      storage: {
        INBOX: { messages: [] },
        '': { separator: '/', folders: Object.fromEntries(Object.entries(folders).map(([name, special]) => [name, { 'special-use': special, messages: [] }])) },
      },
    });
    await new Promise<void>((r) => this.imap.listen(0, r));
    this.imapPort = this.imap.address().port;

    this.smtp = new SMTPServer({
      secure: false,
      disabledCommands: ['STARTTLS'],
      allowInsecureAuth: true,
      authMethods: ['PLAIN', 'LOGIN'],
      logger: false,
      onAuth: (auth, _s, cb) => (auth.username === this.user && auth.password === this.password ? cb(null, { user: auth.username }) : cb(new Error('Invalid username or password'))),
      onData: (stream, session, cb) => {
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('end', () => {
          if (this.failNextSends > 0) {
            this.failNextSends--;
            const err = new Error('Try again later') as Error & { responseCode: number };
            err.responseCode = 451;
            return cb(err);
          }
          this.sent.push({ from: (session.envelope.mailFrom as { address: string }).address, to: session.envelope.rcptTo.map((r) => r.address), raw: Buffer.concat(chunks).toString('utf8') });
          cb();
        });
      },
    });
    await new Promise<void>((r) => this.smtp.listen(0, '127.0.0.1', r));
    this.smtpPort = (this.smtp.server.address() as AddressInfo).port;
    return this;
  }

  /** The form body for connecting this mailbox. */
  settings(email = this.user, password = this.password) {
    return {
      email,
      username: this.user,
      password,
      imap: { host: '127.0.0.1', port: this.imapPort, security: 'TLS' as const },
      smtp: { host: '127.0.0.1', port: this.smtpPort, security: 'TLS' as const },
    };
  }

  changePassword(p: string) {
    this.password = p;
    this.imap.users[this.user]!.password = p;
  }

  deliver(folder: string, raw: string, flags: string[] = [], date = new Date()) {
    return this.imap.appendMessage(folder, flags, date, raw).message;
  }

  messages(folder: string) {
    return this.imap.getMailbox(folder).messages;
  }

  find(folder: string, messageId: string) {
    return this.messages(folder).find((m) => m.raw.includes(`Message-ID: ${messageId}`));
  }

  /** Server-side change, as if made in the provider's own webmail. */
  setFlags(folder: string, uid: number, flags: string[]) {
    const m = this.messages(folder).find((x) => x.uid === uid)!;
    m.flags = flags;
  }

  expunge(folder: string, uid: number) {
    const box = this.imap.getMailbox(folder);
    box.messages = box.messages.filter((m) => m.uid !== uid);
  }

  /** Copies to another folder then expunges the original (a move in webmail). */
  moveOnServer(from: string, uid: number, to: string) {
    const m = this.messages(from).find((x) => x.uid === uid)!;
    this.deliver(to, m.raw, m.flags, new Date(m.internaldate));
    this.expunge(from, uid);
  }

  /** The server renumbers a folder (UIDVALIDITY changes), as after a server migration. */
  renumber(folder: string) {
    const box = this.imap.getMailbox(folder);
    box.uidvalidity += 1;
    let uid = 1000;
    for (const m of box.messages) m.uid = uid++;
    box.uidnext = uid;
  }

  stop() {
    this.imap.close();
    this.smtp.close();
  }
}
