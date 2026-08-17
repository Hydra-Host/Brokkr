import { expect, test } from '../../../fixtures/auth.fixture.js';

test.describe('IPAM - VLAN Groups CRUD', () => {
  test('should display VLAN Groups list page', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    await page.goto('/ipam/vlan-groups');
    await expect(page.getByText('VLAN Groups').first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Create VLAN Group' })).toBeVisible();
  });

  test('should create and delete a VLAN group', async ({ supplyAuthenticatedPage, db, seedData }) => {
    const page = supplyAuthenticatedPage;
    const name = `e2e-vg-${Date.now()}`;
    const zone = await db.prisma.zone.create({
      data: {
        name: `E2E Data Center ${Date.now()}`,
        organizationId: seedData.supplyOrganization.id,
      },
    });

    await page.goto('/ipam/vlan-groups/create');
    await page.getByLabel('Name').fill(name);
    await page.getByLabel('Description').fill('E2E test VLAN group');
    await page.getByLabel('Data Center ID').fill(zone.id);
    await page.getByLabel('Min VID').fill('100');
    await page.getByLabel('Max VID').fill('200');

    await page.getByRole('button', { name: 'Create VLAN Group' }).click();
    await page.waitForURL(/\/ipam\/vlan-groups$/);

    const vg = await db.prisma.vlanGroup.findFirst({ where: { name } });
    expect(vg).not.toBeNull();
    expect(vg!.minVid).toBe(100);
    expect(vg!.maxVid).toBe(200);

    await page.goto(`/ipam/vlan-groups/${vg!.id}/delete`);
    await expect(page.getByText('This action cannot be undone.')).toBeVisible();
    await page.getByRole('button', { name: 'Delete' }).click();
    await page.waitForURL(/\/ipam\/vlan-groups$/);

    const deleted = await db.prisma.vlanGroup.findUnique({ where: { id: vg!.id } });
    expect(deleted).toBeNull();
    await db.prisma.zone.delete({ where: { id: zone.id } });
  });
});

test.describe('IPAM - Gateways list', () => {
  test('should display Gateways list page', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    await page.goto('/ipam/gateways');
    await expect(page.getByText('Gateways').first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Create Gateway' })).toBeVisible();
  });
});

test.describe('IPAM - Roles CRUD', () => {
  test('should display Roles list page', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    await page.goto('/ipam/roles');
    await expect(page.getByText('IPAM Roles').first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Create Role' })).toBeVisible();
  });

  test('should create and delete an IPAM role', async ({ supplyAuthenticatedPage, db }) => {
    const page = supplyAuthenticatedPage;
    const name = `e2e-role-${Date.now()}`;
    const slug = `e2e-role-${Date.now()}`;

    await page.goto('/ipam/roles/create');
    await page.getByLabel('Name').fill(name);
    await page.getByLabel('Slug').fill(slug);
    await page.getByLabel('Weight').fill('500');
    await page.getByLabel('Description').fill('E2E test role');

    await page.getByRole('button', { name: 'Create Role' }).click();
    await page.waitForURL(/\/ipam\/roles$/);

    const role = await db.prisma.ipamPrefixVlanRole.findFirst({ where: { name } });
    expect(role).not.toBeNull();
    expect(role!.slug).toBe(slug);
    expect(role!.weight).toBe(500);

    await page.goto(`/ipam/roles/${role!.id}/delete`);
    await expect(page.getByText('This action cannot be undone.')).toBeVisible();
    await page.getByRole('button', { name: 'Delete' }).click();
    await page.waitForURL(/\/ipam\/roles$/);

    const deleted = await db.prisma.ipamPrefixVlanRole.findUnique({ where: { id: role!.id } });
    expect(deleted).toBeNull();
  });
});
