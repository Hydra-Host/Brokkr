import { PrismaClient } from '@repo/database';
import { permissionKey, RbacConfig } from './types';

export async function seedRbac(prisma: PrismaClient, config: RbacConfig): Promise<void> {
  console.log('Seeding RBAC permissions and system roles...\n');

  const permissionIdMap = new Map<string, string>();
  for (const perm of config.permissions) {
    const record = await prisma.permission.upsert({
      where: { resource_action: { resource: perm.resource, action: perm.action } },
      update: { description: perm.description },
      create: { resource: perm.resource, action: perm.action, description: perm.description },
    });
    permissionIdMap.set(permissionKey(perm.resource, perm.action), record.id);
  }
  console.log(`  ${permissionIdMap.size} permissions upserted`);

  for (const roleDef of config.systemRoles) {
    let role = await prisma.organizationMemberRole.findFirst({
      where: { slug: roleDef.slug, isSystem: true, organizationId: null },
    });

    if (role) {
      role = await prisma.organizationMemberRole.update({
        where: { id: role.id },
        data: { name: roleDef.name, description: roleDef.description },
      });
    } else {
      role = await prisma.organizationMemberRole.create({
        data: {
          name: roleDef.name,
          slug: roleDef.slug,
          description: roleDef.description,
          isSystem: true,
          organizationId: null,
        },
      });
    }

    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });

    const permissionIds = roleDef.permissions
      .map((key) => permissionIdMap.get(key))
      .filter((id): id is string => id !== undefined);

    for (const permissionId of permissionIds) {
      await prisma.rolePermission.create({
        data: { roleId: role.id, permissionId },
      });
    }

    console.log(`  System role "${roleDef.name}" — ${permissionIds.length} permissions`);
  }

  console.log('\nDone.');
}
