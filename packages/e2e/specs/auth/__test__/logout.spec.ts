import { expect, test } from '../../../fixtures/auth.fixture.js';

const isMainAuthCookie = (name: string): boolean => name.includes('better-auth');

test.describe('Logout', () => {
  test.setTimeout(60_000);

  test('should logout and show public inventory', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const cookiesBefore = await page.context().cookies();
    const sessionCookieBefore = cookiesBefore.find(
      (cookie) => isMainAuthCookie(cookie.name) && cookie.name.includes('session'),
    );
    expect(sessionCookieBefore).toBeDefined();

    await page.evaluate(async () => {
      await fetch('/api/v1/auth/sign-out', { method: 'POST', credentials: 'include' });
    });
    await page.goto('/');
    await expect(page).toHaveURL(/\/inventory/);

    const cookiesAfter = await page.context().cookies();
    const sessionCookieAfter = cookiesAfter.find((cookie) => cookie.name === sessionCookieBefore?.name);
    const sessionInvalidated = !sessionCookieAfter || sessionCookieAfter.value !== sessionCookieBefore?.value;
    expect(sessionInvalidated).toBeTruthy();
  });
});
