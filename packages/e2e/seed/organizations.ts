import { createPrismaClient, OrganizationMembershipRole, TenantType } from '@repo/database';

type PrismaClient = ReturnType<typeof createPrismaClient>;

export async function createTestOrganization(prisma: PrismaClient): Promise<{ id: string; name: string }> {
  const user = await prisma.user.findUnique({
    where: { email: 'e2e-orguser@test.brokkr.local' },
  });

  if (!user) {
    throw new Error('e2e-orguser@test.brokkr.local not found — run seed/users.ts first');
  }

  const org = await prisma.organization.create({
    data: {
      name: 'E2E Test Org',
      tenantType: TenantType.DemandCustomer,
    },
  });
  const ownerRoles = await prisma.organizationMemberRole.findMany({
    where: { slug: 'owner', isSystem: true, organizationId: null, archivedAt: null },
    select: { id: true },
    take: 2,
  });
  const [ownerRole] = ownerRoles;
  if (!ownerRole || ownerRoles.length !== 1) {
    throw new Error(`Expected exactly one active owner system role, found ${ownerRoles.length}`);
  }

  await prisma.member.create({
    data: {
      userId: user.id,
      organizationId: org.id,
      role: OrganizationMembershipRole.Owner,
      assignedRoleId: ownerRole.id,
    },
  });

  console.log(`Created organization: ${org.name} (${org.id})`);

  return { id: org.id, name: org.name };
}
