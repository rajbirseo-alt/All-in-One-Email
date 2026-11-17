import { Injectable } from '@nestjs/common';
import { Prisma } from '@crm/db';
import { newId } from '@crm/crypto';
import type { Tx } from '../prisma/prisma.service';
import type { AuditActor, RequestContext } from '../common/request-context';

export interface AuditInput {
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: unknown;
}

/** Fields that must never be copied into audit before/after snapshots. */
const REDACT = new Set(['passwordHash', 'mfaSecretEnc', 'tokenHash', 'ciphertext', 'wrappedDataKey', 'iv', 'authTag']);

function sanitize(v: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (v === undefined || v === null) return Prisma.DbNull;
  return JSON.parse(
    JSON.stringify(v, (k, val) => (REDACT.has(k) ? '[redacted]' : typeof val === 'bigint' ? val.toString() : val)),
  ) as Prisma.InputJsonValue;
}

/** Only the fields that changed — keeps entries small and readable. */
export function diff<T extends Record<string, unknown>>(before: T, after: Partial<T>) {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const k of Object.keys(after)) {
    const bv = before[k];
    const av = after[k];
    const same = bv instanceof Date && av instanceof Date ? bv.getTime() === av.getTime() : JSON.stringify(bv) === JSON.stringify(av);
    if (!same) {
      b[k] = bv;
      a[k] = av;
    }
  }
  return { before: b, after: a, changed: Object.keys(a).length > 0 };
}

@Injectable()
export class AuditService {
  /** Always called with the transaction that performs the change, so the entry commits atomically with it. */
  async record(tx: Tx, actor: RequestContext | AuditActor, input: AuditInput) {
    const isCtx = 'sessionId' in actor;
    await tx.auditLog.create({
      data: {
        id: newId(),
        actorId: actor.userId,
        actorType: isCtx ? 'USER' : (actor.actorType ?? (actor.userId ? 'USER' : 'SYSTEM')),
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        ip: actor.ip ?? null,
        userAgent: actor.userAgent?.slice(0, 500) ?? null,
        before: sanitize(input.before),
        after: sanitize(input.after),
        metadata: sanitize(input.metadata),
      },
    });
  }
}
