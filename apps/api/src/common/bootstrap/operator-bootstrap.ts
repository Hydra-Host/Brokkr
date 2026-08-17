import { INestApplicationContext, Logger } from '@nestjs/common';
import { hashPassword } from '@repo/auth';
import { requireSystemRoleId } from '@repo/auth/rbac';
import { OrganizationMembershipRole, TenantType } from '@repo/database';
import { PrismaClient } from '../../prisma/prisma.client';
import { OPERATOR_POLICY, type OperatorPolicy } from '../authz/operator-policy';
import { BRAND_NAME } from '../branding';

// SECURITY: the default credential is a well-known first-boot login — set BROKKR_ADMIN_PASSWORD or rotate after first login on any internet-reachable deployment.
const DEFAULT_ORG_ID = '00000000-0000-0000-0000-000000000000';
const DEFAULT_ORG_NAME = BRAND_NAME;
const DEFAULT_ADMIN_EMAIL = 'admin@brokkr.local';
const DEFAULT_ADMIN_PASSWORD = 'brokkr';
const OPERATOR_TENANT_TYPE = TenantType.SupplyCustomer;

export async function bootstrapInstanceOperator(app: INestApplicationContext): Promise<void> {
  const logger = new Logger('OperatorBootstrap');

  const policy = app.get<OperatorPolicy>(OPERATOR_POLICY);
  if (!policy.isInstanceOperator({ isInstanceOperator: true })) {
    logger.log('Operator policy denies designation (managed edition) — skipping operator bootstrap');
    return;
  }

  const orgId = process.env.BROKKR_ADMIN_ORG_ID || DEFAULT_ORG_ID;
  const orgName = process.env.BROKKR_ADMIN_ORG_NAME || DEFAULT_ORG_NAME;
  const email = process.env.BROKKR_ADMIN_EMAIL || DEFAULT_ADMIN_EMAIL;
  const password = process.env.BROKKR_ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;

  const prisma = app.get(PrismaClient);

  // Partial-unique index allows one operator org — demote any prior holder in the same transaction in case BROKKR_ADMIN_ORG_ID changed between boots.
  const org = await prisma.$transaction(async (tx) => {
    await tx.organization.updateMany({
      where: { isInstanceOperator: true, id: { not: orgId } },
      data: { isInstanceOperator: false },
    });
    return tx.organization.upsert({
      where: { id: orgId },
      update: { isInstanceOperator: true },
      create: {
        id: orgId,
        name: orgName,
        tenantType: OPERATOR_TENANT_TYPE,
        isInstanceOperator: true,
      },
    });
  });

  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, emailVerified: true, name: 'Admin', firstName: 'Admin', lastName: 'User' },
  });

  const existingCredential = await prisma.account.findFirst({
    where: { userId: user.id, providerId: 'credential' },
  });
  if (!existingCredential) {
    await prisma.account.create({
      data: {
        userId: user.id,
        accountId: user.id,
        providerId: 'credential',
        password: await hashPassword(password),
      },
    });
  }

  const ownerRoleId = await requireSystemRoleId(prisma, OrganizationMembershipRole.Owner);
  await prisma.member.upsert({
    where: { userId_organizationId: { userId: user.id, organizationId: org.id } },
    update: { assignedRoleId: ownerRoleId, deletedAt: null },
    create: {
      userId: user.id,
      organizationId: org.id,
      role: OrganizationMembershipRole.Owner,
      assignedRoleId: ownerRoleId,
      isDefaultOrg: true,
    },
  });

  logger.log(`Instance operator ready: org "${orgName}" (${org.id}), admin Owner ${email}`);
}
