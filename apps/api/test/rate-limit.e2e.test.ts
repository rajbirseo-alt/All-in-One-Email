import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, bootApp, uniqueEmail } from './helpers';

let app: INestApplication;
beforeAll(async () => {
  ({ app } = await bootApp({ env: { LOGIN_RATE_LIMIT_PER_MIN: '10' } })); // production default
});
afterAll(() => app.close());

describe('sign-in rate limit', () => {
  it('blocks the 11th attempt per minute from one IP with 429', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await new Client(app).post('/auth/login', { email: uniqueEmail('rl'), password: 'whatever-123' })).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe('per-employee rate limit', () => {
  it('limits one signed-in employee without affecting colleagues on the same IP', async () => {
    const { bootApp: boot, clientAs, makeUser } = await import('./helpers');
    const { app: a } = await boot({ env: { RATE_LIMIT_PER_USER_PER_MIN: '5' } });
    try {
      const busy = await clientAs(a, (await makeUser({ role: 'EMPLOYEE' })).id);
      const other = await clientAs(a, (await makeUser({ role: 'EMPLOYEE' })).id);
      const codes: number[] = [];
      for (let i = 0; i < 6; i++) codes.push((await busy.get('/auth/me')).status);
      expect(codes.slice(0, 5).every((c) => c === 200)).toBe(true);
      const last = await busy.get('/auth/me');
      expect(last.status).toBe(429);
      expect(last.body.error.code).toBe('RATE_LIMITED');
      expect(Number(last.headers['retry-after'])).toBeGreaterThan(0);
      expect((await other.get('/auth/me')).status).toBe(200);
    } finally {
      await a.close();
    }
  });
});
