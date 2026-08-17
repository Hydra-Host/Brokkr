import { test as base, expect, type Page } from '@playwright/test';
import { OrganizationMembershipRole, TenantType, createPrismaClient } from '@repo/database';

interface UserCredentials {
  email: string;
  password: string;
}

interface SeededOrganization {
  id: string;
  name: string;
}

interface SeedData {
  users: {
    standard: UserCredentials;
    orguser: UserCredentials;
    supply: UserCredentials;
  };
  organization: SeededOrganization;
  supplyOrganization: SeededOrganization;
}

type LoginAsFn = (email: string, password: string) => Promise<void>;
type WaitForPredicate = (value: number) => boolean;

interface DbAssertions {
  prisma: ReturnType<typeof createPrismaClient>;
  getSessionCountByEmail: (email: string) => Promise<number>;
  getSessionCountByEmailAndUserAgent: (email: string, userAgent: string) => Promise<number>;
  getAccountCountByEmail: (email: string) => Promise<number>;
  waitForSessionCountByEmail: (email: string, predicate: WaitForPredicate, description: string) => Promise<number>;
  waitForSessionCountByEmailAndUserAgent: (
    email: string,
    userAgent: string,
    predicate: WaitForPredicate,
    description: string,
  ) => Promise<number>;
  waitForAccountCountByEmail: (email: string, predicate: WaitForPredicate, description: string) => Promise<number>;
  waitForUserByEmail: (email: string, description: string) => Promise<{ id: string; email: string }>;
}

interface TestFixtures {
  loginAs: LoginAsFn;
  authenticatedPage: Page;
  supplyAuthenticatedPage: Page;
}

interface WorkerFixtures {
  db: DbAssertions;
  seedData: SeedData;
}

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://brokkr:password@localhost:5432/brokkr';
const API_URL = process.env.API_URL ?? 'http://localhost:3000';
const POLL_INTERVAL_MS = 500;
const MAX_POLL_ATTEMPTS = 40;

const seedAuthUser = async (email: string, password: string, firstName: string, lastName: string): Promise<void> => {
  const origin = process.env.BASE_URL ?? 'http://localhost:5173';
  const response = await fetch(`${API_URL}/api/v1/auth/sign-up/email`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      Referer: `${origin}/`,
    },
    body: JSON.stringify({
      email,
      password,
      name: `${firstName} ${lastName}`,
      firstName,
      lastName,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to seed test user through API: ${response.status} ${await response.text()}`);
  }
};

const loginAndActivateOrganization = async (
  db: DbAssertions,
  loginAs: LoginAsFn,
  user: UserCredentials,
  organization: SeededOrganization,
): Promise<void> => {
  const preLoginSessionCount = await db.getSessionCountByEmail(user.email);
  await loginAs(user.email, user.password);
  const dbUser = await db.waitForUserByEmail(user.email, 'user should exist before session activation');
  await db.waitForSessionCountByEmail(
    user.email,
    (count) => count > preLoginSessionCount,
    'new session row should exist before org activation',
  );
  const activated = await db.prisma.session.updateMany({
    where: { userId: dbUser.id, expiresAt: { gt: new Date() } },
    data: { activeOrganizationId: organization.id },
  });
  if (activated.count === 0) {
    throw new Error('org activation patched zero sessions — login session missing or already expired');
  }
};

export const test = base.extend<TestFixtures, WorkerFixtures>({
  loginAs: async ({ page }, use) => {
    const loginFn: LoginAsFn = async (email: string, password: string) => {
      await page.goto('/auth/login');
      await page.getByLabel('Email Address').fill(email);
      await page.getByLabel('Password').fill(password);
      await page.getByRole('button', { name: 'Login' }).click();
      await page.waitForURL((url) => !url.toString().includes('/auth/login'));
    };
    await use(loginFn);
  },

  authenticatedPage: async ({ page, loginAs, seedData, db }, use) => {
    await loginAndActivateOrganization(db, loginAs, seedData.users.orguser, seedData.organization);
    await use(page);
  },

  supplyAuthenticatedPage: async ({ page, loginAs, seedData, db }, use) => {
    await loginAndActivateOrganization(db, loginAs, seedData.users.supply, seedData.supplyOrganization);
    await use(page);
  },

  db: [
    async ({}, use) => {
      const prisma = createPrismaClient({ connectionString: DATABASE_URL });

      const sleep = async (ms: number): Promise<void> =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        });

      const waitForCount = async (
        fetchCount: () => Promise<number>,
        predicate: WaitForPredicate,
        description: string,
      ): Promise<number> => {
        for (let attempt = 0; attempt <= MAX_POLL_ATTEMPTS; attempt += 1) {
          const current = await fetchCount();
          if (predicate(current)) {
            return current;
          }
          if (attempt < MAX_POLL_ATTEMPTS) {
            await sleep(POLL_INTERVAL_MS);
          }
        }
        throw new Error(`Timed out waiting for DB state: ${description}`);
      };

      const db: DbAssertions = {
        prisma,
        getSessionCountByEmail: async (email: string) =>
          prisma.session.count({
            where: { user: { email } },
          }),
        getSessionCountByEmailAndUserAgent: async (email: string, userAgent: string) =>
          prisma.session.count({
            where: {
              user: { email },
              userAgent,
            },
          }),
        getAccountCountByEmail: async (email: string) =>
          prisma.account.count({
            where: { user: { email } },
          }),
        waitForSessionCountByEmail: async (email, predicate, description) =>
          waitForCount(
            async () =>
              prisma.session.count({
                where: { user: { email } },
              }),
            predicate,
            description,
          ),
        waitForSessionCountByEmailAndUserAgent: async (email, userAgent, predicate, description) =>
          waitForCount(
            async () =>
              prisma.session.count({
                where: {
                  user: { email },
                  userAgent,
                },
              }),
            predicate,
            description,
          ),
        waitForAccountCountByEmail: async (email, predicate, description) =>
          waitForCount(
            async () =>
              prisma.account.count({
                where: { user: { email } },
              }),
            predicate,
            description,
          ),
        waitForUserByEmail: async (email: string, description: string) => {
          for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
            const user = await prisma.user.findUnique({
              where: { email },
              select: { id: true, email: true },
            });
            if (user) {
              return user;
            }
            await sleep(POLL_INTERVAL_MS);
          }
          throw new Error(`Timed out waiting for user in DB: ${description}`);
        },
      };

      await use(db);
      await prisma.$disconnect();
    },
    { scope: 'worker', timeout: 120_000 },
  ],

  seedData: [
    async ({ db }, use, workerInfo) => {
      const runId = process.env.E2E_RUN_ID ?? 'local';
      const workerTag = `${runId}-w${workerInfo.workerIndex}`;

      const standardEmail = `e2e-standard-${workerTag}@test.brokkr.local`;
      const orgUserEmail = `e2e-orguser-${workerTag}@test.brokkr.local`;
      const supplyUserEmail = `e2e-supply-${workerTag}@test.brokkr.local`;
      const password = 'TestPassword123!';
      const orgName = `E2E Test Org ${workerInfo.workerIndex}`;
      const supplyOrgName = `E2E Supply Test Org ${workerInfo.workerIndex}`;
      const workerEmails = [standardEmail, orgUserEmail, supplyUserEmail];
      const organizationNames = [orgName, supplyOrgName];

      await db.prisma.session.deleteMany({
        where: {
          user: {
            email: { in: workerEmails },
          },
        },
      });
      await db.prisma.member.deleteMany({
        where: {
          OR: [
            {
              user: {
                email: { in: workerEmails },
              },
            },
            {
              organization: {
                name: { in: organizationNames },
              },
            },
          ],
        },
      });
      await db.prisma.organization.deleteMany({
        where: { name: { in: organizationNames } },
      });
      await db.prisma.account.deleteMany({
        where: {
          user: {
            email: { in: workerEmails },
          },
        },
      });
      await db.prisma.user.deleteMany({
        where: {
          email: { in: workerEmails },
        },
      });

      for (const user of [
        { email: standardEmail, firstName: 'E2E', lastName: `Standard${workerInfo.workerIndex}` },
        { email: orgUserEmail, firstName: 'E2E', lastName: `Orguser${workerInfo.workerIndex}` },
        { email: supplyUserEmail, firstName: 'E2E', lastName: `Supply${workerInfo.workerIndex}` },
      ]) {
        await seedAuthUser(user.email, password, user.firstName, user.lastName);
      }

      const [orgUser, supplyUser] = await Promise.all([
        db.waitForUserByEmail(orgUserEmail, 'org user should exist before membership setup'),
        db.waitForUserByEmail(supplyUserEmail, 'supply user should exist before membership setup'),
      ]);
      await db.prisma.user.updateMany({
        where: { email: { in: [orgUserEmail, supplyUserEmail] } },
        data: { emailVerified: true },
      });

      const [organization, supplyOrganization] = await Promise.all([
        db.prisma.organization.create({
          data: {
            name: orgName,
            tenantType: TenantType.DemandCustomer,
          },
        }),
        db.prisma.organization.create({
          data: {
            name: supplyOrgName,
            tenantType: TenantType.SupplyCustomer,
          },
        }),
      ]);
      const ownerRoles = await db.prisma.organizationMemberRole.findMany({
        where: { slug: 'owner', isSystem: true, organizationId: null, archivedAt: null },
        select: { id: true },
        take: 2,
      });
      const [ownerRole] = ownerRoles;
      if (!ownerRole || ownerRoles.length !== 1) {
        throw new Error(`Expected exactly one active owner system role, found ${ownerRoles.length}`);
      }

      const upsertOwnerMembership = (userId: string, organizationId: string) =>
        db.prisma.member.upsert({
          where: {
            userId_organizationId: {
              userId,
              organizationId,
            },
          },
          update: {
            role: OrganizationMembershipRole.Owner,
            isDefaultOrg: true,
            assignedRoleId: ownerRole.id,
          },
          create: {
            userId,
            organizationId,
            role: OrganizationMembershipRole.Owner,
            isDefaultOrg: true,
            assignedRoleId: ownerRole.id,
          },
        });
      await Promise.all([
        upsertOwnerMembership(orgUser.id, organization.id),
        upsertOwnerMembership(supplyUser.id, supplyOrganization.id),
      ]);

      await use({
        users: {
          standard: { email: standardEmail, password },
          orguser: { email: orgUserEmail, password },
          supply: { email: supplyUserEmail, password },
        },
        organization: { id: organization.id, name: organization.name },
        supplyOrganization: { id: supplyOrganization.id, name: supplyOrganization.name },
      });
    },
    { scope: 'worker', timeout: 120_000 },
  ],
});

export { expect };
