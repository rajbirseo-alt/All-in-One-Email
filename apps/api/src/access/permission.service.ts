import { Injectable } from '@nestjs/common';
import { resolvePermissions, type EffectivePermissions, type Scope } from '@crm/shared';
import { PrismaService, type Tx } from '../prisma/prisma.service';

@Injectable()
export class PermissionService {
  constructor(private readonly prisma: PrismaService) {}

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
