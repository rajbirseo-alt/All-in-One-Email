import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@crm/db';

/**
 * Who the database is working for (Postgres Row-Level Security, docs/05 §5 layer 3).
 *
 * - Inside an HTTP request: the signed-in employee and their `conversation.read` scope (a public
 *   route has no user, so RLS hides every conversation row — fail closed).
 * - Outside a request (event listeners, jobs started in the API process, tests driving services
 *   directly): `system`, which RLS lets through.
 */
export interface DbContext {
  userId: string | null;
  /** conversation.read scope: ALL | DEPARTMENT | TEAM | ASSIGNED | OWN | '' (none). */
  scope: string;
  system?: boolean;
  /** Set while a batch transaction that already carries the settings runs. */
  inTx?: boolean;
}
export const dbContext = new AsyncLocalStorage<DbContext>();

/** Runs `fn` as the system (no employee filter). Use only for work that is not done on behalf of the caller. */
export function asSystem<T>(fn: () => T): T {
  return dbContext.run({ userId: null, scope: '', system: true }, fn);
}

function settings(store: DbContext | undefined): [string, string, string] {
  if (!store || store.system) return ['', '', 'on'];
  return [store.userId ?? '', store.userId ? store.scope : '', ''];
}

const setSql = (s: [string, string, string]) =>
  Prisma.sql`SELECT set_config('app.user_id', ${s[0]}, true), set_config('app.thread_scope', ${s[1]}, true), set_config('app.system', ${s[2]}, true)`;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  /**
   * The API process turns this on (create-app): every statement then runs in a transaction that
   * first states the caller (set_config … is_local). The worker leaves it off; its sessions never
   * set `app.user_id`, which the policies treat as a trusted background process.
   */
  static rlsContext = false;

  constructor() {
    super();
    if (!PrismaService.rlsContext) return;
    const base = this;
    const baseTx = PrismaClient.prototype.$transaction as (this: PrismaClient, ...a: unknown[]) => Promise<unknown>;
    const ext = base.$extends({
      query: {
        async $allOperations({ args, query }) {
          const store = dbContext.getStore();
          if (store?.inTx) return query(args);
          const r = (await baseTx.call(base, [base.$executeRaw(setSql(settings(store))), query(args)])) as unknown[];
          return r[1];
        },
      },
    });
    /** Interactive transactions set the context once at the start; batches get it as their first statement. */
    const transaction = (arg: unknown, opts?: unknown) => {
      const store = dbContext.getStore();
      if (store?.inTx) return baseTx.call(base, arg, opts);
      const s = settings(store);
      const inner: DbContext = { ...(store ?? { userId: null, scope: '', system: true }), inTx: true };
      if (typeof arg === 'function') {
        return baseTx.call(
          base,
          async (tx: PrismaClient) => {
            await tx.$executeRaw(setSql(s));
            // Queries on `tx` are not hooked (base client); others made meanwhile get their own context.
            return (arg as (tx: PrismaClient) => Promise<unknown>)(tx);
          },
          opts,
        );
      }
      return dbContext.run(inner, async () => ((await baseTx.call(base, [base.$executeRaw(setSql(s)), ...(arg as unknown[])], opts)) as unknown[]).slice(1));
    };
    const own: Record<string | symbol, unknown> = {
      $transaction: transaction,
      onModuleInit: () => base.$connect(),
      onModuleDestroy: () => base.$disconnect(),
      $connect: () => base.$connect(),
      $disconnect: () => base.$disconnect(),
    };
    return new Proxy(ext, { get: (t, p, r) => (p in own ? own[p] : Reflect.get(t, p, r)) }) as unknown as PrismaService;
  }

  async onModuleInit() {
    await this.$connect();
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }
}

export type Tx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'>;

/** Runs `fn` with the database context of this employee (e.g. checking what a live-update subscriber may see). */
export function asUser<T>(ctx: { userId: string; permissions: Record<string, string | undefined> }, fn: () => T): T {
  return dbContext.run({ userId: ctx.userId, scope: ctx.permissions['conversation.read'] ?? '' }, fn);
}

/**
 * Inside a transaction: runs one already-authorised step as the system, then restores the
 * caller's context. Used for a hand-over, after which the caller may no longer see the
 * conversation (Postgres checks the updated row against the read policy).
 */
export async function systemStep<T>(tx: Tx, fn: () => Promise<T>): Promise<T> {
  await tx.$executeRaw`SELECT set_config('app.system', 'on', true)`;
  try {
    return await fn();
  } finally {
    await tx.$executeRaw`SELECT set_config('app.system', ${dbContext.getStore()?.system || !dbContext.getStore() ? 'on' : ''}, true)`;
  }
}
