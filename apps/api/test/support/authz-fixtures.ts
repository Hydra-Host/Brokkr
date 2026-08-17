import { AuthClient, permissionKeysToRecord } from '@repo/auth';
import { requireSystemRoleId } from '@repo/auth/rbac';
import { OrganizationMembershipRole } from '@repo/database';
import { randomUUID } from 'crypto';
import { PrismaClient } from '../../src/prisma/prisma.client';

export function makeAuthzFixtures(prisma: PrismaClient, authClient: AuthClient) {
  const uniq = () => randomUUID();

  const mkOrg = () => prisma.organization.create({ data: { name: `org-${uniq()}`, tenantType: 'SupplyCustomer' } });

  const mkUser = () =>
    prisma.user.create({ data: { email: `u-${uniq()}@example.com`, name: `u-${uniq()}`, emailVerified: true } });

  async function mkMember(userId: string, organizationId: string, role: OrganizationMembershipRole) {
    const assignedRoleId = await requireSystemRoleId(prisma, role);
    return prisma.member.create({ data: { userId, organizationId, role, assignedRoleId } });
  }

  async function mkKey(
    userId: string,
    organizationId: string,
    flatPerms?: string[],
  ): Promise<{ id: string; key: string }> {
    const result = await authClient.api.createApiKey({
      body: {
        name: `k-${uniq().slice(0, 8)}`,
        userId,
        metadata: { organizationId },
        ...(flatPerms ? { permissions: permissionKeysToRecord(flatPerms) } : {}),
      },
    });
    await prisma.apiKey.update({ where: { id: result.id }, data: { organizationId } });
    return { id: result.id, key: result.key };
  }

  async function actor(role: OrganizationMembershipRole, keyScope?: string[]) {
    const org = await mkOrg();
    const user = await mkUser();
    await mkMember(user.id, org.id, role);
    const authKey = await mkKey(user.id, org.id, keyScope);
    return { orgId: org.id, userId: user.id, authKey };
  }

  return { uniq, mkOrg, mkUser, mkMember, mkKey, actor };
}
