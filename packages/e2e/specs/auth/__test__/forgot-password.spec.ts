import { expect, test } from '../../../fixtures/auth.fixture.js';

const API_URL = process.env.API_URL ?? 'http://localhost:3000';
const MAILPIT_URL = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const ORIGIN = process.env.BASE_URL ?? 'http://localhost:5173';

async function seedUser(email: string, password: string): Promise<void> {
  const response = await fetch(`${API_URL}/api/v1/auth/sign-up/email`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: ORIGIN,
      Referer: `${ORIGIN}/`,
    },
    body: JSON.stringify({
      email,
      password,
      name: 'Reset Revoke',
      firstName: 'Reset',
      lastName: 'Revoke',
    }),
  });
  if (!response.ok) {
    throw new Error(`Failed to seed reset-flow user: ${response.status} ${await response.text()}`);
  }
}

async function waitForPasswordResetLink(email: string): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const search = await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`);
    if (!search.ok) {
      throw new Error(`Mailpit search failed: ${search.status}`);
    }
    const listing: { messages?: Array<{ ID: string; Subject: string }> } = await search.json();
    const resetMessage = listing.messages?.find((message) => message.Subject.toLowerCase().includes('reset'));
    if (resetMessage) {
      const detail = await fetch(`${MAILPIT_URL}/api/v1/message/${resetMessage.ID}`);
      if (!detail.ok) {
        throw new Error(`Mailpit message fetch failed: ${detail.status}`);
      }
      const body: { Text?: string; HTML?: string } = await detail.json();
      const haystack = `${body.Text ?? ''}\n${body.HTML ?? ''}`;
      const match = haystack.match(/https?:\/\/[^\s"'<>)\]]+\/auth\/reset-password\/[A-Za-z0-9_-]+[^\s"'<>)\]]*/);
      if (match?.[0]) {
        return match[0];
      }
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });
  }
  throw new Error(`Timed out waiting for password reset email to ${email}`);
}

test.describe('Forgot Password', () => {
  test('should show confirmation after submitting email', async ({ page, seedData }) => {
    await page.goto('/auth/forgot-password');
    await page.getByLabel('Email Address').fill(seedData.users.orguser.email);
    await page.getByRole('button', { name: 'Send Reset Link' }).click();
    await expect(page.getByText('Check Your Email')).toBeVisible();
  });

  test('should revoke existing sessions after password reset completes', async ({ page, db }) => {
    test.setTimeout(60_000);

    const email = `reset-revoke-${Date.now()}@example.com`;
    const oldPassword = 'OldPassword123!';
    const newPassword = 'NewPassword456!';

    await seedUser(email, oldPassword);

    await page.goto('/auth/login');
    await page.getByLabel('Email Address').fill(email);
    await page.getByLabel('Password').fill(oldPassword);
    await page.getByRole('button', { name: 'Login' }).click();
    await page.waitForURL((url) => !url.toString().includes('/auth/login'));

    await db.waitForSessionCountByEmail(email, (count) => count > 0, 'login should create a session before reset');

    await page.goto('/auth/forgot-password');
    await page.getByLabel('Email Address').fill(email);
    await page.getByRole('button', { name: 'Send Reset Link' }).click();
    await expect(page.getByText('Check Your Email')).toBeVisible();

    const resetLink = await waitForPasswordResetLink(email);
    await page.goto(resetLink);
    await expect(page).toHaveURL(new RegExp(`^${ORIGIN}/auth/reset-password\\?token=[A-Za-z0-9_-]+$`));
    await page.getByLabel('New Password').fill(newPassword);
    await page.getByLabel('Confirm Password').fill(newPassword);
    await page.getByRole('button', { name: 'Reset Password' }).click();
    await expect(page.getByText('Your password has been reset successfully')).toBeVisible();

    await db.waitForSessionCountByEmail(
      email,
      (count) => count === 0,
      'password reset should revoke existing sessions',
    );
  });
});
