import { expect, test } from '../../../fixtures/auth.fixture.js';

test.describe('Organization Settings', () => {
  test('should display current organization settings', async ({ authenticatedPage, seedData }) => {
    const page = authenticatedPage;

    await page.goto('/organizations/settings');

    await expect(page.getByText('General Settings')).toBeVisible();
    await expect(page.getByText("Update your organization's basic information.")).toBeVisible();
    await expect(page.getByLabel('Organization Name')).toHaveValue(seedData.organization.name);
    await expect(page.getByLabel('Contact Email')).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Country' })).toBeVisible();

    await expect(page.getByText('Organization Details')).toBeVisible();
    await expect(page.getByText(seedData.organization.id, { exact: true })).toBeVisible();
    await expect(page.getByText('Demand Customer', { exact: true })).toBeVisible();
  });

  test('should keep save disabled until the form is edited', async ({ authenticatedPage, seedData }) => {
    const page = authenticatedPage;

    await page.goto('/organizations/settings');

    const nameInput = page.getByLabel('Organization Name');
    await expect(nameInput).toHaveValue(seedData.organization.name);

    const saveButton = page.getByRole('button', { name: 'Save Changes' });
    await expect(saveButton).toBeDisabled();

    await nameInput.fill(`${seedData.organization.name} dirty ${Date.now()}`);
    await expect(saveButton).toBeEnabled();
  });

  test('should update the organization name', async ({ authenticatedPage, db, seedData }) => {
    const page = authenticatedPage;
    const orgId = seedData.organization.id;
    const original = await db.prisma.organization.findUnique({ where: { id: orgId } });
    expect(original).not.toBeNull();
    const newName = `E2E Org Rename ${Date.now()}`;

    try {
      await page.goto('/organizations/settings');

      const nameInput = page.getByLabel('Organization Name');
      await expect(nameInput).toHaveValue(original!.name);
      await nameInput.fill(newName);
      await page.getByRole('button', { name: 'Save Changes' }).click();

      await expect(page.getByText('Settings saved successfully!')).toBeVisible();

      const updated = await db.prisma.organization.findUnique({ where: { id: orgId } });
      expect(updated!.name).toBe(newName);
    } finally {
      await db.prisma.organization.update({ where: { id: orgId }, data: { name: original!.name } });
    }
  });

  test('should update the contact email', async ({ authenticatedPage, db, seedData }) => {
    const page = authenticatedPage;
    const orgId = seedData.organization.id;
    const original = await db.prisma.organization.findUnique({ where: { id: orgId } });
    expect(original).not.toBeNull();
    const newEmail = `e2e-org-settings-${Date.now()}@test.brokkr.local`;

    try {
      await page.goto('/organizations/settings');

      await expect(page.getByLabel('Organization Name')).toHaveValue(original!.name);

      const emailInput = page.getByLabel('Contact Email');
      await expect(emailInput).toHaveValue(original!.email ?? '');
      await emailInput.fill(newEmail);
      await page.getByRole('button', { name: 'Save Changes' }).click();

      await expect(page.getByText('Settings saved successfully!')).toBeVisible();

      const updated = await db.prisma.organization.findUnique({ where: { id: orgId } });
      expect(updated!.email).toBe(newEmail);
    } finally {
      await db.prisma.organization.update({ where: { id: orgId }, data: { email: original!.email } });
    }
  });

  test('should update the country', async ({ authenticatedPage, db, seedData }) => {
    const page = authenticatedPage;
    const orgId = seedData.organization.id;
    const original = await db.prisma.organization.findUnique({ where: { id: orgId } });
    expect(original).not.toBeNull();

    try {
      await page.goto('/organizations/settings');

      await expect(page.getByLabel('Organization Name')).toHaveValue(original!.name);

      await page.getByRole('combobox', { name: 'Country' }).click();
      await page.getByRole('option', { name: 'Iceland' }).click();
      await page.getByRole('button', { name: 'Save Changes' }).click();

      await expect(page.getByText('Settings saved successfully!')).toBeVisible();

      const updated = await db.prisma.organization.findUnique({ where: { id: orgId } });
      expect(updated!.country).toBe('IS');
    } finally {
      await db.prisma.organization.update({ where: { id: orgId }, data: { country: original!.country } });
    }
  });
});
