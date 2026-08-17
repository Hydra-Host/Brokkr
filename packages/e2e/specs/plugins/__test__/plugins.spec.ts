import { expect, test } from '../../../fixtures/auth.fixture.js';

test.describe('Plugins smoke', () => {
  test('should display the plugins index page', async ({ authenticatedPage }) => {
    const page = authenticatedPage;

    await page.goto('/plugins');

    await expect(page.getByRole('heading', { name: 'Plugins', exact: true })).toBeVisible();
    await expect(page.getByText('Installed plugins that contribute a root page.')).toBeVisible();
  });

  test('should show the empty state when no root-route plugins are mounted for the org', async ({
    authenticatedPage,
  }) => {
    const page = authenticatedPage;

    const pylonConfigured = Boolean(
      process.env.PYLON_API_TOKEN && process.env.PYLON_ACCOUNT_ID && process.env.BROKKR_ADMIN_ORG_ID,
    );
    const clickhouseConfigured = Boolean(
      process.env.CLICKHOUSE_HOST && process.env.CLICKHOUSE_USER && process.env.CLICKHOUSE_PASSWORD,
    );
    test.skip(
      pylonConfigured || clickhouseConfigured,
      'managed root-route plugins are credential-enabled in this environment, so the index is not empty',
    );

    await page.goto('/plugins');

    await expect(page.getByText('No plugins with root routes are installed')).toBeVisible();
  });

  test('should render not found for an unknown plugin id and its sub-paths', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const unknownPluginId = `e2e-unknown-${Date.now()}`;

    await page.goto(`/plugins/${unknownPluginId}`);
    await expect(page.getByRole('heading', { name: 'Page Not Found' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Go Back' })).toBeVisible();

    await page.goto(`/plugins/${unknownPluginId}/some/nested/path`);
    await expect(page.getByRole('heading', { name: 'Page Not Found' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Go Back' })).toBeVisible();
  });
});
