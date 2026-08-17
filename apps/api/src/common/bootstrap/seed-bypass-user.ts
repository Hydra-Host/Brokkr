import { INestApplicationContext } from '@nestjs/common';
import { hashPassword } from '@repo/auth';
import { requireSystemRoleId } from '@repo/auth/rbac';
import { OrganizationMembershipRole, type TenantType } from '@repo/database';
import { getErrorMessage } from 'src/common/error-utils';
import { PrismaClient } from '../../prisma/prisma.client';
import { resolveAuthBypassPolicy } from '../local-simulation';

const SIM_USER_EMAIL = 'brokkr@brokkr.local';
const SIM_USER_PASSWORD = 'brokkr';
const SIM_USER_NAME = 'brokkr';
const SIM_USER_FIRST_NAME = 'Brokkr';
const SIM_USER_LAST_NAME = 'Local';
const SIM_ORG_ID = '00000000-0000-0000-0000-000000000000';
const SIM_ORG_NAME = 'Brokkr Org';

const EXTRA_ORG_SPECS: OrgOwnerSpec[] = [
  {
    orgId: '00000000-0000-0000-0000-000000000001',
    orgName: 'Demand Org',
    tenantType: 'DemandCustomer',
    email: 'demand@brokkr.local',
    name: 'demand',
    firstName: 'Demand',
    lastName: 'Local',
  },
  {
    orgId: '00000000-0000-0000-0000-000000000002',
    orgName: 'Supply Org',
    tenantType: 'SupplyCustomer',
    email: 'supply@brokkr.local',
    name: 'supply',
    firstName: 'Supply',
    lastName: 'Local',
  },
];

const SIM_ORG_USER_SPECS: LocalUserSpec[] = [
  {
    email: 'brokkr-1@brokkr.local',
    name: 'brokkr-1',
    firstName: 'Brokkr',
    lastName: 'One',
    role: OrganizationMembershipRole.Member,
  },
  {
    email: 'brokkr-2@brokkr.local',
    name: 'brokkr-2',
    firstName: 'Brokkr',
    lastName: 'Two',
    role: OrganizationMembershipRole.Admin,
  },
];

interface OrgOwnerSpec {
  orgId: string;
  orgName: string;
  tenantType: TenantType;
  email: string;
  name: string;
  firstName: string;
  lastName: string;
  isInstanceOperator?: boolean;
  preserveExistingAssignedRole?: boolean;
}

interface LocalUserSpec {
  email: string;
  name: string;
  firstName: string;
  lastName: string;
  role: OrganizationMembershipRole;
  preserveExistingAssignedRole?: boolean;
}

type SignUpFn = (args: {
  body: { email: string; password: string; name: string; firstName: string; lastName: string };
}) => Promise<unknown>;
interface AuthClientLike {
  api: { signUpEmail: SignUpFn };
}

export interface SeedBypassUserOptions {
  authClientToken: 'AUTH_CLIENT' | 'ADMIN_AUTH_CLIENT';
  rehashCredential?: boolean;
}

async function seedOrgWithOwner(
  prisma: PrismaClient,
  auth: AuthClientLike,
  rehashCredential: boolean,
  spec: OrgOwnerSpec,
): Promise<void> {
  const isInstanceOperator = spec.isInstanceOperator ?? false;
  await prisma.organization.upsert({
    where: { id: spec.orgId },
    update: { isInstanceOperator },
    create: {
      id: spec.orgId,
      name: spec.orgName,
      tenantType: spec.tenantType,
      isInstanceOperator,
    },
  });

  await seedLocalMembership(prisma, auth, rehashCredential, spec.orgId, spec.orgName, {
    email: spec.email,
    name: spec.name,
    firstName: spec.firstName,
    lastName: spec.lastName,
    role: OrganizationMembershipRole.Owner,
    preserveExistingAssignedRole: spec.preserveExistingAssignedRole,
  });
}

async function seedLocalMembership(
  prisma: PrismaClient,
  auth: AuthClientLike,
  rehashCredential: boolean,
  organizationId: string,
  organizationName: string,
  spec: LocalUserSpec,
): Promise<void> {
  const assignedRoleId = await requireSystemRoleId(prisma, spec.role);

  try {
    await auth.api.signUpEmail({
      body: {
        email: spec.email,
        password: SIM_USER_PASSWORD,
        name: spec.name,
        firstName: spec.firstName,
        lastName: spec.lastName,
      },
    });
    console.info(`[bootstrap] created user ${spec.email} in org ${organizationName}`);
  } catch (error) {
    const msg = getErrorMessage(error);
    if (msg.includes('USER_ALREADY_EXISTS') || msg.includes('already exists')) {
      console.info(`[bootstrap] user ${spec.email} already exists — skip`);
    } else {
      throw new Error(`[bootstrap] failed to seed user ${spec.email}: ${msg}`, { cause: error });
    }
  }

  const user = await prisma.user.findUnique({ where: { email: spec.email } });
  if (!user) return;

  const update = spec.preserveExistingAssignedRole
    ? { role: spec.role, deletedAt: null }
    : { role: spec.role, assignedRoleId, deletedAt: null };
  await prisma.member.upsert({
    where: { userId_organizationId: { userId: user.id, organizationId } },
    update,
    create: {
      userId: user.id,
      organizationId,
      role: spec.role,
      assignedRoleId,
    },
  });

  if (rehashCredential) {
    await prisma.account.updateMany({
      where: { userId: user.id, providerId: 'credential' },
      data: { password: await hashPassword(SIM_USER_PASSWORD) },
    });
  }

  console.info(`[bootstrap] user ${spec.email} reconciled as ${spec.role} of ${organizationName}`);
}

export async function seedBypassUser(
  app: INestApplicationContext,
  { authClientToken, rehashCredential = false }: SeedBypassUserOptions,
): Promise<void> {
  if (!resolveAuthBypassPolicy().seedBypassUser) return;

  const prisma = app.get(PrismaClient);
  const auth = app.get<AuthClientLike>(authClientToken);

  const forceBoss = process.env.HH_FORCE_BOSS === 'true';

  if (forceBoss) {
    await prisma.organization.updateMany({
      where: { isInstanceOperator: true, id: { not: SIM_ORG_ID } },
      data: { isInstanceOperator: false },
    });
  }

  await seedOrgWithOwner(prisma, auth, rehashCredential, {
    orgId: SIM_ORG_ID,
    orgName: SIM_ORG_NAME,
    tenantType: 'SupplyCustomer',
    isInstanceOperator: forceBoss,
    email: SIM_USER_EMAIL,
    name: SIM_USER_NAME,
    firstName: SIM_USER_FIRST_NAME,
    lastName: SIM_USER_LAST_NAME,
    preserveExistingAssignedRole: true,
  });

  for (const spec of SIM_ORG_USER_SPECS) {
    await seedLocalMembership(prisma, auth, rehashCredential, SIM_ORG_ID, SIM_ORG_NAME, spec);
  }

  for (const spec of EXTRA_ORG_SPECS) {
    await seedOrgWithOwner(prisma, auth, rehashCredential, spec);
  }
}
