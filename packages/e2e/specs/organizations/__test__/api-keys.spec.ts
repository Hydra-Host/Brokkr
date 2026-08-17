import { expect, test } from '../../../fixtures/auth.fixture.js';

test.describe('Organization API Keys', () => {
  let orgUserId: string;

  test.beforeAll(async ({ db, seedData }) => {
    const orgUser = await db.waitForUserByEmail(
      seedData.users.orguser.email,
      'org user should exist before seeding api keys',
    );
    orgUserId = orgUser.id;
  });

  const seedApiKeyData = (name: string, organizationId: string) => ({
    name,
    key: `e2e-hashed-secret-${Date.now()}`,
    start: 'brk_e2e',
    prefix: 'brk_',
    userId: orgUserId,
    organizationId,
  });

  test.afterEach(async ({ db, seedData }) => {
    await db.prisma.apiKey.deleteMany({
      where: { organizationId: seedData.organization.id, name: { startsWith: 'e2e-key-' } },
    });
  });

  test('should display api keys list page', async ({ authenticatedPage, db, seedData }) => {
    const page = authenticatedPage;
    const keyName = `e2e-key-list-${Date.now()}`;

    await db.prisma.apiKey.create({ data: seedApiKeyData(keyName, seedData.organization.id) });

    await page.goto('/organizations/api-keys');
    await expect(page.getByText('Manage API keys for programmatic access to your organization.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Create Key' })).toBeVisible();
    await expect(page.getByText(keyName, { exact: true })).toBeVisible();
  });

  test('should create an api key and reveal the secret exactly once', async ({ authenticatedPage, db, seedData }) => {
    const page = authenticatedPage;
    const keyName = `e2e-key-create-${Date.now()}`;

    await page.goto('/organizations/api-keys/create');
    await expect(page.getByRole('heading', { name: 'Create API Key' })).toBeVisible();

    await page.getByLabel('Name').fill(keyName);
    await page.getByRole('button', { name: 'Create Key' }).click();

    await expect(page.getByRole('heading', { name: 'API Key Created' })).toBeVisible();
    await expect(
      page.getByText("Copy your API key now. You won't be able to see it again after closing this dialog."),
    ).toBeVisible();

    const revealed =
      (await page.getByRole('dialog').locator('code').filter({ hasNotText: 'x-api-key' }).textContent()) ?? '';
    expect(revealed).toMatch(/^brk_/);
    expect(revealed.length).toBeGreaterThan(20);

    const orgUser = await db.waitForUserByEmail(seedData.users.orguser.email, 'org user should exist after create');
    const row = await db.prisma.apiKey.findFirst({
      where: { name: keyName, organizationId: seedData.organization.id },
    });
    expect(row).not.toBeNull();
    expect(row!.userId).toBe(orgUser.id);
    expect(row!.enabled).toBe(true);
    expect(row!.expiresAt).toBeNull();

    await page.getByRole('button', { name: 'Done' }).click();
    await page.waitForURL(/\/organizations\/api-keys(\?.*)?$/);
    await expect(page.getByText(keyName, { exact: true })).toBeVisible();
  });

  test('should create an api key with an expiration', async ({ authenticatedPage, db, seedData }) => {
    const page = authenticatedPage;
    const keyName = `e2e-key-expiry-${Date.now()}`;

    await page.goto('/organizations/api-keys/create');
    await expect(page.getByRole('heading', { name: 'Create API Key' })).toBeVisible();

    await page.getByLabel('Name').fill(keyName);
    await page.getByLabel('Expiration (days)').fill('30');
    await page.getByRole('button', { name: 'Create Key' }).click();

    await expect(page.getByRole('heading', { name: 'API Key Created' })).toBeVisible();

    const row = await db.prisma.apiKey.findFirst({
      where: { name: keyName, organizationId: seedData.organization.id },
    });
    expect(row).not.toBeNull();
    expect(row!.expiresAt).not.toBeNull();
    const expectedExpiryMs = Date.now() + 30 * 24 * 60 * 60 * 1000;
    expect(Math.abs(row!.expiresAt!.getTime() - expectedExpiryMs)).toBeLessThan(10 * 60 * 1000);

    await page.getByRole('button', { name: 'Done' }).click();
    await page.waitForURL(/\/organizations\/api-keys(\?.*)?$/);
  });

  test('should view api key details', async ({ authenticatedPage, db, seedData }) => {
    const page = authenticatedPage;
    const keyName = `e2e-key-detail-${Date.now()}`;

    const seeded = await db.prisma.apiKey.create({ data: seedApiKeyData(keyName, seedData.organization.id) });

    await page.goto(`/organizations/api-keys/details/${seeded.id}`);

    const sheet = page.getByRole('dialog');
    await expect(sheet.getByText(keyName)).toBeVisible();
    await expect(sheet.getByText('Active')).toBeVisible();
    await expect(sheet.getByText('Created by')).toBeVisible();
    await expect(sheet.getByRole('heading', { name: 'Permissions' })).toBeVisible();

    await sheet.getByRole('button', { name: 'Close' }).first().click();
    await page.waitForURL(/\/organizations\/api-keys(\?.*)?$/);
  });

  test('should open details when clicking a key row in the list', async ({ authenticatedPage, db, seedData }) => {
    const page = authenticatedPage;
    const keyName = `e2e-key-rowclick-${Date.now()}`;

    const seeded = await db.prisma.apiKey.create({ data: seedApiKeyData(keyName, seedData.organization.id) });

    await page.goto('/organizations/api-keys');
    await page.getByText(keyName, { exact: true }).click();

    await page.waitForURL(new RegExp(`/organizations/api-keys/details/${seeded.id}$`));
    await expect(page.getByRole('dialog').getByText(keyName)).toBeVisible();
  });

  test('should delete an api key', async ({ authenticatedPage, db, seedData }) => {
    const page = authenticatedPage;
    const keyName = `e2e-key-delete-${Date.now()}`;

    const seeded = await db.prisma.apiKey.create({ data: seedApiKeyData(keyName, seedData.organization.id) });

    await page.goto(`/organizations/api-keys/delete/${seeded.id}`);

    await expect(page.getByRole('heading', { name: 'Delete API Key' })).toBeVisible();
    await expect(
      page.getByText('This action cannot be undone. Any applications using this key will lose access immediately.'),
    ).toBeVisible();

    await page.getByLabel('API Key Name').fill(keyName);
    await page.getByRole('button', { name: 'Delete Key' }).click();

    await page.waitForURL(/\/organizations\/api-keys(\?.*)?$/);

    const deleted = await db.prisma.apiKey.findUnique({ where: { id: seeded.id } });
    expect(deleted).toBeNull();
  });
});
