import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { resolvePermissions, type EffectivePermissions, type Scope } from '@crm/shared';
import { PrismaService, type Tx } from '../prisma/prisma.service';

@Injectable()
export class PermissionService {
  private readonly cache = new Map<string, { at: number; value: EffectivePermissions }>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  /**
   * Effective permissions for a signed-in request, cached per employee for
   * PERMISSION_CACHE_SECONDS (default 30; Phase 10 load test: this saved several queries on every
   * request). Changes made through this API instance apply at once (invalidate); other instances
   * pick them up within the cache time.
   */
  async forRequest(userId: string): Promise<EffectivePermissions> {
    const ttl = this.cfg.PERMISSION_CACHE_SECONDS * 1000;
    if (ttl <= 0) return this.effectiveFor(userId);
    const hit = this.cache.get(userId);
    const now = Date.now();
    if (hit && now - hit.at < ttl) return hit.value;
    const value = await this.effectiveFor(userId);
    if (this.cache.size > 5000) this.cache.clear();
    this.cache.set(userId, { at: now, value });
    return value;
  }

  /** After a role, its permissions, a user's role or their overrides change (all users when omitted). */
  invalidate(userId?: string) {
    if (userId) this.cache.delete(userId);
    else this.cache.clear();
  }

  /** Effective permissions = role matrix ± unexpired per-user overrides. */
  async effectiveFor(userId: string, db: Tx = this.prisma): Promise<EffectivePermissions> {
    const user = await db.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        role: { select: { permissions: { select: { scope: true, permission: { select: { key: true } } } } } },
        permissionOverrides: {
          select: { effect: true, scope: true, expiresAt: true, permission: { select: { key: true } } },
        },
      },
    });
    return resolvePermissions({
      rolePermissions: user.role.permissions.map((p) => ({ key: p.permission.key, scope: p.scope as Scope })),
      overrides: user.permissionOverrides.map((o) => ({
        key: o.permission.key,
        effect: o.effect,
        scope: (o.scope as Scope | null) ?? null,
        expiresAt: o.expiresAt,
      })),
    });
  }
}
