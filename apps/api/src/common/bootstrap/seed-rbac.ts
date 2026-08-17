import { INestApplicationContext } from '@nestjs/common';
import { PrismaClient } from '../../prisma/prisma.client';
import { printSeedSummary, seedPermissions } from '../../scripts/rbac/permissions';

// Must run unconditionally: production hubs need the Permission/RolePermission catalog too,
// otherwise the bootstrap admin roles resolve to zero permissions (403 on everything).
export async function seedRbac(app: INestApplicationContext): Promise<void> {
  const prisma = app.get(PrismaClient);
  console.info('[bootstrap] seeding RBAC permissions + system roles');
  printSeedSummary(await seedPermissions(prisma));
}
