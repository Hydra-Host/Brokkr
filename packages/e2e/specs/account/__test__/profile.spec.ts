import { expect, test } from '../../../fixtures/auth.fixture.js';

test.describe('Account Profile', () => {
  test.setTimeout(60_000);

  test('should redirect /account to /account/profile', async ({ authenticatedPage }) => {
    const page = authenticatedPage;

    await page.goto('/account');

    await page.waitForURL(/\/account\/profile$/);

    await expect(page.getByText('User Profile').first()).toBeVisible();
    await expect(page.getByText('Update your personal information.')).toBeVisible();
  });

  test('should display current user email and prefilled name fields', async ({ authenticatedPage, db, seedData }) => {
    const page = authenticatedPage;

    const user = await db.prisma.user.findUnique({
      where: { email: seedData.users.orguser.email },
      select: { firstName: true, lastName: true },
    });
    expect(user).not.toBeNull();

    await page.goto('/account/profile');
    await expect(page.getByText('User Profile').first()).toBeVisible();

    await expect(page.locator('#profile-email')).toHaveText(seedData.users.orguser.email);

    await expect(page.getByLabel('First Name')).toHaveValue(user!.firstName ?? '');
    await expect(page.getByLabel('Last Name')).toHaveValue(user!.lastName ?? '');
  });

  test('should update first and last name and persist to the database', async ({ authenticatedPage, db, seedData }) => {
    const page = authenticatedPage;
    const email = seedData.users.orguser.email;
    const stamp = Date.now();
    const newFirstName = `E2eFirst${stamp}`;
    const newLastName = `E2eLast${stamp}`;

    const original = await db.prisma.user.findUnique({
      where: { email },
      select: { firstName: true, lastName: true, name: true },
    });
    expect(original).not.toBeNull();

    try {
      await page.goto('/account/profile');
      await expect(page.getByText('Update your personal information.')).toBeVisible();

      await page.getByLabel('First Name').clear();
      await page.getByLabel('First Name').fill(newFirstName);
      await page.getByLabel('Last Name').clear();
      await page.getByLabel('Last Name').fill(newLastName);

      await page.getByRole('button', { name: 'Save Changes' }).click();

      await expect(page.getByText('Profile updated successfully')).toBeVisible();

      const updated = await db.prisma.user.findUnique({
        where: { email },
        select: { firstName: true, lastName: true, name: true },
      });
      expect(updated!.firstName).toBe(newFirstName);
      expect(updated!.lastName).toBe(newLastName);
      expect(updated!.name).toBe(`${newFirstName} ${newLastName}`);
    } finally {
      await db.prisma.user.update({
        where: { email },
        data: {
          firstName: original!.firstName,
          lastName: original!.lastName,
          name: original!.name,
        },
      });
    }
  });

  test('should show validation error when first name is empty', async ({ authenticatedPage, db, seedData }) => {
    const page = authenticatedPage;
    const email = seedData.users.orguser.email;

    const original = await db.prisma.user.findUnique({
      where: { email },
      select: { firstName: true, lastName: true },
    });
    expect(original).not.toBeNull();

    await page.goto('/account/profile');
    await expect(page.getByText('Update your personal information.')).toBeVisible();

    await page.getByLabel('First Name').clear();
    await page.getByRole('button', { name: 'Save Changes' }).click();

    await expect(page.getByText('First name is required')).toBeVisible();

    const after = await db.prisma.user.findUnique({
      where: { email },
      select: { firstName: true, lastName: true },
    });
    expect(after!.firstName).toBe(original!.firstName);
    expect(after!.lastName).toBe(original!.lastName);
  });

  test('should show validation error when last name is empty', async ({ authenticatedPage, db, seedData }) => {
    const page = authenticatedPage;
    const email = seedData.users.orguser.email;

    const original = await db.prisma.user.findUnique({
      where: { email },
      select: { firstName: true, lastName: true },
    });
    expect(original).not.toBeNull();

    await page.goto('/account/profile');
    await expect(page.getByText('Update your personal information.')).toBeVisible();

    await page.getByLabel('Last Name').clear();
    await page.getByRole('button', { name: 'Save Changes' }).click();

    await expect(page.getByText('Last name is required')).toBeVisible();

    const after = await db.prisma.user.findUnique({
      where: { email },
      select: { firstName: true, lastName: true },
    });
    expect(after!.firstName).toBe(original!.firstName);
    expect(after!.lastName).toBe(original!.lastName);
  });
});
