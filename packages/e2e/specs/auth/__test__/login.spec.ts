import { expect, test } from '../../../fixtures/auth.fixture.js';

const isMainAuthCookie = (name: string): boolean => name.includes('better-auth');

test.describe('Login', () => {
  test.setTimeout(60_000);

  test('should login with valid credentials', async ({ page, seedData, db }) => {
    const browserUserAgent = await page.evaluate(() => navigator.userAgent);
    const sessionCountBefore = await db.getSessionCountByEmailAndUserAgent(
      seedData.users.orguser.email,
      browserUserAgent,
    );

    await page.goto('/auth/login');
    await page.getByLabel('Email Address').fill(seedData.users.orguser.email);
    await page.getByLabel('Password').fill(seedData.users.orguser.password);
    await page.getByRole('button', { name: 'Login' }).click();
    await page.waitForURL((url) => !url.toString().includes('/auth/login'));

    await db.waitForSessionCountByEmailAndUserAgent(
      seedData.users.orguser.email,
      browserUserAgent,
      (count) => count > sessionCountBefore,
      'login should create a browser-bound session row',
    );

    const cookies = await page.context().cookies();
    const authCookies = cookies.filter((cookie) => isMainAuthCookie(cookie.name));
    expect(authCookies.length).toBeGreaterThan(0);

    const sessionCookie = authCookies.find((cookie) => cookie.name.includes('session'));
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie?.value).toBeTruthy();
    expect(sessionCookie?.httpOnly).toBeTruthy();

    const twoFactorCookie = authCookies.find((cookie) => cookie.name.includes('two_factor'));
    expect(twoFactorCookie).toBeUndefined();
  });

  test('should show error with invalid credentials', async ({ page, seedData }) => {
    await page.goto('/auth/login');
    await page.getByLabel('Email Address').fill(seedData.users.orguser.email);
    await page.getByLabel('Password').fill('WrongPassword999!');
    await page.getByRole('button', { name: 'Login' }).click();
    await expect(page.getByRole('paragraph').filter({ hasText: 'Invalid email or password' })).toBeVisible();
  });

  test('should navigate to signup', async ({ page }) => {
    await page.goto('/auth/login');
    await page.getByRole('link', { name: 'Sign up' }).click();
    await expect(page).toHaveURL(/\/auth\/signup/);
  });

  test('should navigate to forgot password', async ({ page }) => {
    await page.goto('/auth/login');
    await page.getByRole('link', { name: 'Forgot password?' }).click();
    await expect(page).toHaveURL(/\/auth\/forgot-password/);
  });
});
