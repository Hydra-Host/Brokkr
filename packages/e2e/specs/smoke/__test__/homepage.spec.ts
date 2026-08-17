import { test as base, expect } from '@playwright/test';
import { test as authTest } from '../../../fixtures/auth.fixture.js';

base.describe('Homepage - Unauthenticated', () => {
  base('should show public inventory to unauthenticated users', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/inventory/);
  });
});

authTest.describe('Homepage - Authenticated', () => {
  authTest('should show app for authenticated users', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    await page.goto('/');
    await expect(page.locator('body')).toBeVisible();
    const currentUrl = page.url();
    if (currentUrl.includes('/auth/setup-two-factor')) {
      await expect(page.getByRole('heading', { name: 'Two-Factor Authentication' })).toBeVisible();
      return;
    }

    await expect(page).not.toHaveURL(/\/auth\//);
  });
});
