import type { Page } from '@playwright/test';
import { OrganizationMembershipRole, TenantType } from '@repo/database';
import { expect, test } from '../../../fixtures/auth.fixture.js';

const loginAndWaitForOnboarding = async (
  page: Page,
  loginAs: (email: string, password: string) => Promise<void>,
  credentials: { email: string; password: string },
): Promise<void> => {
  await loginAs(credentials.email, credentials.password);
  await page.waitForURL((url) => url.pathname.startsWith('/onboarding/organization'));
};

test.describe('Onboarding - Create Organization', () => {
  test.setTimeout(60_000);

  test('should route a user without an organization to onboarding after login', async ({ page, loginAs, seedData }) => {
    await loginAndWaitForOnboarding(page, loginAs, seedData.users.standard);

    await expect(page.getByText('Create Your Organization')).toBeVisible();
    await expect(page.getByLabel('Organization Name')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create Organization' })).toBeVisible();
  });

  test('should show a validation error when the organization name is empty', async ({
    page,
    loginAs,
    db,
    seedData,
  }) => {
    await loginAndWaitForOnboarding(page, loginAs, seedData.users.standard);

    await page.getByRole('button', { name: 'Create Organization' }).click();

    await expect(page.getByText('Organization name is required')).toBeVisible();
    await expect(page).toHaveURL(/\/onboarding\/organization/);

    const membershipCount = await db.prisma.member.count({
      where: { user: { email: seedData.users.standard.email } },
    });
    expect(membershipCount).toBe(0);
  });

  test('should reject an organization name longer than 100 characters', async ({ page, loginAs, db, seedData }) => {
    const longName = `e2e-onboarding-toolong-${Date.now()}-`.padEnd(101, 'x');

    await loginAndWaitForOnboarding(page, loginAs, seedData.users.standard);

    await page.getByLabel('Organization Name').fill(longName);
    await page.getByRole('button', { name: 'Create Organization' }).click();

    await expect(page.getByText('Organization name must be less than 100 characters')).toBeVisible();
    await expect(page).toHaveURL(/\/onboarding\/organization/);

    const organization = await db.prisma.organization.findFirst({ where: { name: longName } });
    expect(organization).toBeNull();
  });

  test('should create the organization with owner membership and default project', async ({
    page,
    loginAs,
    db,
    seedData,
  }) => {
    const orgName = `E2E Onboarding Org ${Date.now()}`;
    const { email } = seedData.users.standard;

    try {
      await loginAndWaitForOnboarding(page, loginAs, seedData.users.standard);

      await page.getByLabel('Organization Name').fill(orgName);
      await page.getByRole('button', { name: 'Create Organization' }).click();

      await page.waitForURL((url) => url.pathname.startsWith('/deployments'));

      const user = await db.prisma.user.findUnique({ where: { email } });
      expect(user).not.toBeNull();

      const organization = await db.prisma.organization.findFirst({ where: { name: orgName } });
      expect(organization).not.toBeNull();
      expect(organization!.tenantType).toBe(TenantType.DemandCustomer);

      const membership = await db.prisma.member.findUnique({
        where: { userId_organizationId: { userId: user!.id, organizationId: organization!.id } },
      });
      expect(membership).not.toBeNull();
      expect(membership!.role).toBe(OrganizationMembershipRole.Owner);

      const project = await db.prisma.deploymentProject.findFirst({
        where: { organizationId: organization!.id },
      });
      expect(project).not.toBeNull();
      expect(project!.name).toBe('Default Project');
      expect(project!.isDefault).toBe(true);

      const activeSession = await db.prisma.session.findFirst({
        where: { user: { email }, activeOrganizationId: organization!.id },
      });
      expect(activeSession).not.toBeNull();
    } finally {
      await db.prisma.session.deleteMany({ where: { user: { email } } });
      const createdOrgs = await db.prisma.organization.findMany({ where: { name: orgName } });
      for (const org of createdOrgs) {
        await db.prisma.deploymentProject.deleteMany({ where: { organizationId: org.id } });
        await db.prisma.member.deleteMany({ where: { organizationId: org.id } });
        await db.prisma.organization.delete({ where: { id: org.id } });
      }
    }
  });

  test('should show organization selection when the user already belongs to an organization', async ({
    page,
    loginAs,
    db,
    seedData,
  }) => {
    const orgName = `E2E Existing Org ${Date.now()}`;
    const { email } = seedData.users.standard;

    const user = await db.prisma.user.findUnique({ where: { email } });
    expect(user).not.toBeNull();

    const ownerRole = await db.prisma.organizationMemberRole.findFirst({
      where: { slug: 'owner', isSystem: true, organizationId: null },
      select: { id: true },
    });
    expect(ownerRole).not.toBeNull();

    const organization = await db.prisma.organization.create({
      data: { name: orgName, tenantType: TenantType.DemandCustomer },
    });

    try {
      await db.prisma.member.create({
        data: {
          userId: user!.id,
          organizationId: organization.id,
          role: OrganizationMembershipRole.Owner,
          assignedRoleId: ownerRole!.id,
        },
      });

      await loginAndWaitForOnboarding(page, loginAs, seedData.users.standard);

      await expect(page.getByText('Select Organization')).toBeVisible();
      await expect(page.getByText(orgName)).toBeVisible();
      await expect(page.getByText('Create Your Organization')).toHaveCount(0);
    } finally {
      await db.prisma.session.deleteMany({ where: { user: { email } } });
      await db.prisma.member.deleteMany({ where: { organizationId: organization.id } });
      await db.prisma.organization.delete({ where: { id: organization.id } });
    }
  });
});
