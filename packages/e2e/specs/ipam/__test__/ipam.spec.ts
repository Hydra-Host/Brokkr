import { expect, test } from '../../../fixtures/auth.fixture.js';

test.describe('IPAM - ASNs CRUD', () => {
  test('should display ASNs list page', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    await page.goto('/ipam/asns');
    await expect(page.getByText('ASNs').first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Create ASN' })).toBeVisible();
  });

  test('should create and delete an ASN', async ({ supplyAuthenticatedPage, db }) => {
    const page = supplyAuthenticatedPage;
    const asnNumber = 64512 + Math.floor(Math.random() * 1000);

    await page.goto('/ipam/asns/create');
    await expect(page.getByText('ASN Details').first()).toBeVisible();

    await page.getByRole('spinbutton', { name: 'ASN' }).fill(String(asnNumber));
    await page.getByLabel('Description').fill('E2E test ASN');

    await page.getByRole('button', { name: 'Create ASN' }).click();
    await page.waitForURL(/\/ipam\/asns$/);

    const asn = await db.prisma.asn.findFirst({ where: { asn: asnNumber } });
    expect(asn).not.toBeNull();

    await page.goto(`/ipam/asns/${asn!.id}/delete`);
    await expect(page.getByText('This action cannot be undone.')).toBeVisible();
    await page.getByRole('button', { name: 'Delete' }).click();
    await page.waitForURL(/\/ipam\/asns$/);

    const deleted = await db.prisma.asn.findUnique({ where: { id: asn!.id } });
    expect(deleted).toBeNull();
  });
});

test.describe('IPAM - VRFs CRUD', () => {
  test('should display VRFs list page', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    await page.goto('/ipam/vrfs');
    await expect(page.getByText('VRFs').first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Create VRF' })).toBeVisible();
  });

  test('should create, view, edit, and delete a VRF', async ({ supplyAuthenticatedPage, db, seedData }) => {
    const page = supplyAuthenticatedPage;
    const vrfName = `e2e-vrf-${Date.now()}`;

    await page.goto('/ipam/vrfs/create');
    await page.getByLabel('Name').fill(vrfName);
    await page.getByLabel('Route Distinguisher').fill('65000:1');
    await page.getByLabel('Description').fill('E2E test VRF');

    await page.getByRole('button', { name: 'Create VRF' }).click();
    await page.waitForURL(/\/ipam\/vrfs$/);

    const vrf = await db.prisma.vrf.findFirst({
      where: { name: vrfName, organizationId: seedData.supplyOrganization.id },
    });
    expect(vrf).not.toBeNull();
    expect(vrf!.rd).toBe('65000:1');

    await page.goto(`/ipam/vrfs/${vrf!.id}`);
    await expect(page.getByText(vrfName).first()).toBeVisible();
    await expect(page.getByText('Details').first()).toBeVisible();

    await page.goto(`/ipam/vrfs/${vrf!.id}/edit`);
    await expect(page.getByText('Edit VRF').first()).toBeVisible();
    await page.getByLabel('Description').clear();
    await page.getByLabel('Description').fill('Updated by E2E');
    await page.getByRole('button', { name: 'Save Changes' }).click();
    await page.waitForURL(new RegExp(`/ipam/vrfs/${vrf!.id}$`));

    const updated = await db.prisma.vrf.findUnique({ where: { id: vrf!.id } });
    expect(updated!.description).toBe('Updated by E2E');

    await page.goto(`/ipam/vrfs/${vrf!.id}/delete`);
    await page.getByRole('button', { name: 'Delete' }).click();
    await page.waitForURL(/\/ipam\/vrfs$/);

    const deleted = await db.prisma.vrf.findUnique({ where: { id: vrf!.id } });
    expect(deleted!.deletedAt).not.toBeNull();
  });
});

test.describe('IPAM - VLANs list', () => {
  test('should display VLANs list page', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    await page.goto('/ipam/vlans');
    await expect(page.getByText('VLANs').first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Create VLAN' })).toBeVisible();
  });
});

test.describe('IPAM - Prefixes list', () => {
  test('should display Prefixes list page', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    await page.goto('/ipam/prefixes');
    await expect(page.getByText('Prefixes').first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Create Prefix' })).toBeVisible();
  });
});

test.describe('IPAM - IP Addresses list', () => {
  test('should display IP Addresses list page', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    await page.goto('/ipam/ip-addresses');
    await expect(page.getByText('IP Addresses').first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Create IP Address' })).toBeVisible();
  });
});

test.describe('IPAM - IP Ranges list', () => {
  test('should display IP Ranges list page', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    await page.goto('/ipam/ip-ranges');
    await expect(page.getByText('IP Ranges').first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Create IP Range' })).toBeVisible();
  });
});
