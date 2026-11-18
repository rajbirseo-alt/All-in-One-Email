import type { INestApplication } from '@nestjs/common';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@crm/crypto';
import { EventsHub } from '../src/events/events.service';
import { SyncService } from '../src/mail/sync.service';
import { FakeMail } from './fake-mail';
import { bootApp, type Client, clientAs, makeUser, prisma } from './helpers';
import { connectMailbox, gmailMessage, MAIL_ENV, uniqueMailbox } from './mail-helpers';

let fake: FakeMail;
let app: INestApplication;
let base: string;
let admin: Client;
const box = uniqueMailbox('live');
let boxId: string;

/** Opens an SSE stream with the client's cookies and collects events. */
function openStream(c: Client) {
  const events: { event: string; data: string }[] = [];
  let res: IncomingMessage | null = null;
  const ready = new Promise<number>((resolve) => {
    const req = httpRequest(`${base}/api/v1/events`, { headers: { cookie: [...c.cookies].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ') } }, (r) => {
      res = r;
      let buf = '';
      r.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (event) events.push({ event, data: data ?? '' });
        }
      });
      resolve(r.statusCode ?? 0);
    });
    req.end();
  });
  return { events, ready, close: () => res?.destroy() };
}

const until = async (cond: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  return cond();
};

beforeAll(async () => {
  EventsHub.heartbeatMs = 300;
  fake = await new FakeMail().start();
  ({ app } = await bootApp({ mailEndpoints: fake.endpoints(), env: MAIL_ENV }));
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  admin = await clientAs(app, (await makeUser({ role: 'SUPER_ADMIN' })).id);
  fake.gmailAdd(box, gmailMessage(box, 'e1'));
  boxId = await connectMailbox(admin, fake, 'google', box);
  await app.get(SyncService).run(boxId, 'INITIAL');
});

afterAll(async () => {
  await app.close();
  fake.stop();
  EventsHub.heartbeatMs = 25_000;
});

describe('live updates', () => {
  it('delivers thread ids only to users who may see the thread', async () => {
    const allowed = await makeUser({ role: 'EMPLOYEE' });
    await prisma.emailAccountAccess.create({ data: { id: newId(), emailAccountId: boxId, userId: allowed.id, level: 'READ' } });
    const outsider = await makeUser({ role: 'EMPLOYEE' });
    const a = openStream(await clientAs(app, allowed.id));
    const o = openStream(await clientAs(app, outsider.id));
    expect(await a.ready).toBe(200);
    expect(await o.ready).toBe(200);

    const t = await prisma.emailThread.findFirstOrThrow({ where: { emailAccountId: boxId } });
    fake.gmailAdd(box, gmailMessage(box, 'e2', { threadId: t.providerThreadId!, date: new Date() }));
    await app.get(SyncService).run(boxId, 'WEBHOOK'); // new mail, as the worker would process it

    expect(await until(() => a.events.some((e) => e.event === 'thread.updated'))).toBe(true);
    expect(JSON.parse(a.events.find((e) => e.event === 'thread.updated')!.data)).toEqual({ threadIds: [t.id] });
    await new Promise((r) => setTimeout(r, 500));
    expect(o.events.filter((e) => e.event === 'thread.updated')).toEqual([]);
    a.close();
    o.close();
  });

  it('ends the stream when the session is revoked', async () => {
    const u = await makeUser({ role: 'EMPLOYEE' });
    const s = openStream(await clientAs(app, u.id));
    expect(await s.ready).toBe(200);
    await prisma.session.updateMany({ where: { userId: u.id }, data: { revokedAt: new Date() } });
    expect(await until(() => s.events.some((e) => e.event === 'session.ended'))).toBe(true);
  });

  it('requires a signed-in user with conversation access', async () => {
    const r = await new Promise<number>((resolve) => httpRequest(`${base}/api/v1/events`, (res) => resolve(res.statusCode ?? 0)).end());
    expect(r).toBe(401);
  });
});
