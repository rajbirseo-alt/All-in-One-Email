/**
 * Idempotent seed: permission catalogue + system roles with their default matrix.
 *
 * Safe to run on every deploy:
 *  - new permission keys are inserted, descriptions refreshed;
 *  - a system role that does not exist yet gets its full default matrix;
 *  - an existing role only receives defaults for permissions created in *this* run,
 *    so scopes an admin has edited are never overwritten.
 * No users are created here — use the `create-super-admin` CLI in apps/api.
 */
import { PrismaClient, type PermissionScope } from '@prisma/client';
import { DEFAULT_ROLE_MATRIX, PERMISSIONS, SYSTEM_ROLES, type PermissionKey } from '@crm/shared';
import { newId } from '@crm/crypto';

export async function seed(prisma: PrismaClient) {
  const created = new Set<PermissionKey>();
  const permIds = new Map<string, string>();

  for (const [key, description] of Object.entries(PERMISSIONS) as [PermissionKey, string][]) {
    const existing = await prisma.permission.findUnique({ where: { key } });
    if (existing) {
      if (existing.description !== description) {
        await prisma.permission.update({ where: { key }, data: { description } });
      }
      permIds.set(key, existing.id);
    } else {
      const p = await prisma.permission.create({ data: { id: newId(), key, description } });
      permIds.set(key, p.id);
      created.add(key);
    }
  }

  let rolesCreated = 0;
  for (const [key, meta] of Object.entries(SYSTEM_ROLES) as [keyof typeof SYSTEM_ROLES, { name: string; description: string }][]) {
    const matrix = DEFAULT_ROLE_MATRIX[key];
    let role = await prisma.role.findUnique({ where: { key } });
    const isNew = !role;
    if (!role) {
      role = await prisma.role.create({
        data: { id: newId(), key, name: meta.name, description: meta.description, isSystem: true },
      });
      rolesCreated++;
    }
    const grants = (Object.entries(matrix) as [PermissionKey, PermissionScope][]).filter(
      ([perm]) => isNew || created.has(perm),
    );
    if (grants.length) {
      await prisma.rolePermission.createMany({
        data: grants.map(([perm, scope]) => ({ roleId: role!.id, permissionId: permIds.get(perm)!, scope })),
        skipDuplicates: true,
      });
    }
  }

  return { permissionsCreated: created.size, rolesCreated };
}

if (require.main === module) {
  const prisma = new PrismaClient();
  seed(prisma)
    .then((r) => console.log(`Seed complete: ${r.permissionsCreated} permissions and ${r.rolesCreated} roles created.`))
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
