import { expect, test } from '../../../fixtures/auth.fixture.js';

test.describe('Signup', () => {
  test.setTimeout(60_000);

  test('should create a new account', async ({ page }) => {
    const timestamp = Date.now();
    const email = `e2e-signup-${timestamp}@test.brokkr.local`;

    await page.goto('/auth/signup');
    await page.getByLabel('First Name').fill('E2E');
    await page.getByLabel('Last Name').fill(`Newuser${timestamp}`);
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill('TestPassword123!');
    await page.getByRole('button', { name: 'Sign Up' }).click();

    await expect(page).toHaveURL(/\/auth\/setup-two-factor/);
    await expect(page.getByRole('heading', { name: 'Set Up Two-Factor Authentication' })).toBeVisible();
  });

  test('should show error for duplicate email', async ({ page, seedData }) => {
    await page.goto('/auth/signup');
    await page.getByLabel('First Name').fill('E2E');
    await page.getByLabel('Last Name').fill('Duplicate');
    await page.getByLabel('Email').fill(seedData.users.orguser.email);
    await page.getByLabel('Password').fill('TestPassword123!');
    await page.getByRole('button', { name: 'Sign Up' }).click();
    await expect(page.getByRole('paragraph').filter({ hasText: 'Failed to create account' })).toBeVisible();
  });

  test('should show validation errors on empty submit', async ({ page }) => {
    await page.goto('/auth/signup');
    await page.getByRole('button', { name: 'Sign Up' }).click();
    await expect(page.getByText('First Name is required')).toBeVisible();
  });
});
