import { WebhookEventType } from '@repo/database';
import { expect, test } from '../../../fixtures/auth.fixture.js';

test.describe('Organization Webhooks CRUD', () => {
  test.afterEach(async ({ db, seedData }) => {
    await db.prisma.webhookDelivery.deleteMany({
      where: { webhook: { organizationId: seedData.organization.id } },
    });
    await db.prisma.webhook.deleteMany({ where: { organizationId: seedData.organization.id } });
  });

  test('should display webhooks list with a seeded webhook', async ({ authenticatedPage, db, seedData }) => {
    const page = authenticatedPage;
    const endpoint = `https://example.com/e2e-webhooks/list-${Date.now()}`;

    await db.prisma.webhook.create({
      data: {
        endpoint,
        description: 'Webhook for list test',
        events: [WebhookEventType.DEVICE_LISTING_CREATED],
        secret: `e2e-secret-list-${Date.now()}`,
        organizationId: seedData.organization.id,
      },
    });

    await page.goto('/organizations/webhooks');
    await expect(page.getByText('Configure webhook endpoints to receive event notifications.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Create Webhook' })).toBeVisible();

    const row = page.getByRole('row').filter({ hasText: endpoint });
    await expect(row).toHaveCount(1);
    await expect(row.getByText('Device Listing Created')).toBeVisible();
    await expect(row.getByText('Active', { exact: true })).toBeVisible();
  });

  test('should show empty state when the organization has no webhooks', async ({ authenticatedPage, db, seedData }) => {
    const page = authenticatedPage;

    await db.prisma.webhook.deleteMany({ where: { organizationId: seedData.organization.id } });

    await page.goto('/organizations/webhooks');
    await expect(page.getByRole('heading', { name: 'No Webhooks' })).toBeVisible();
    await expect(page.getByText('Create a webhook to receive event notifications at your endpoint.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Create Your First Webhook' })).toBeVisible();
  });

  test('should create a webhook and show the signing secret once', async ({ authenticatedPage, db, seedData }) => {
    const page = authenticatedPage;
    const endpoint = `https://example.com/e2e-webhooks/create-${Date.now()}`;

    await page.goto('/organizations/webhooks/create');
    await expect(page.getByRole('heading', { name: 'Create Webhook' })).toBeVisible();

    await page.getByLabel('Webhook URL').fill(endpoint);
    await page.getByLabel('Description').fill('Created by E2E test');

    await page.getByLabel('Events').click();
    await page.getByRole('option', { name: 'Device Listing Created' }).click();
    await page.getByRole('option', { name: 'Deployment Interrupted' }).click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('option', { name: 'Deployment Interrupted' })).toBeHidden();

    await page.getByRole('button', { name: 'Create Webhook' }).click();

    await expect(page.getByRole('heading', { name: 'Webhook Created' })).toBeVisible();
    await expect(page.getByText("you won't be able to see it again")).toBeVisible();

    const webhook = await db.prisma.webhook.findFirst({
      where: { endpoint, organizationId: seedData.organization.id },
    });
    expect(webhook).not.toBeNull();
    expect([...webhook!.events].sort()).toEqual(
      [WebhookEventType.DEVICE_LISTING_CREATED, WebhookEventType.DEPLOYMENT_INTERRUPTED].sort(),
    );
    expect(webhook!.description).toBe('Created by E2E test');
    expect(webhook!.isActive).toBe(true);
    expect(webhook!.secret).toMatch(/^[0-9a-f]{64}$/);

    await expect(page.getByRole('dialog').getByText(webhook!.secret)).toBeVisible();

    await page.getByRole('button', { name: 'Done' }).click();
    await page.waitForURL(/\/organizations\/webhooks$/);

    await expect(page.getByRole('row').filter({ hasText: endpoint })).toHaveCount(1);
    await expect(page.getByRole('main').getByText(webhook!.secret)).toHaveCount(0);
  });

  test('should require at least one event when creating a webhook', async ({ authenticatedPage, db, seedData }) => {
    const page = authenticatedPage;
    const endpoint = `https://example.com/e2e-webhooks/no-events-${Date.now()}`;

    await page.goto('/organizations/webhooks/create');
    await page.getByLabel('Webhook URL').fill(endpoint);
    await page.getByRole('button', { name: 'Create Webhook' }).click();

    await expect(page.getByText('Select at least one event')).toBeVisible();

    const count = await db.prisma.webhook.count({
      where: { endpoint, organizationId: seedData.organization.id },
    });
    expect(count).toBe(0);
  });

  test('should edit a webhook url and events', async ({ authenticatedPage, db, seedData }) => {
    const page = authenticatedPage;
    const endpoint = `https://example.com/e2e-webhooks/edit-${Date.now()}`;
    const updatedEndpoint = `${endpoint}-updated`;

    const webhook = await db.prisma.webhook.create({
      data: {
        endpoint,
        description: 'Before edit',
        events: [WebhookEventType.DEVICE_LISTING_CREATED],
        secret: `e2e-secret-edit-${Date.now()}`,
        organizationId: seedData.organization.id,
      },
    });

    await page.goto(`/organizations/webhooks/edit/${webhook.id}`);
    await expect(page.getByRole('heading', { name: 'Edit Webhook' })).toBeVisible();

    await expect(page.getByLabel('Webhook URL')).toHaveValue(endpoint);

    await page.getByLabel('Webhook URL').fill(updatedEndpoint);
    await page.getByLabel('Description').fill('After edit');

    const eventsTrigger = page.getByLabel('Events');
    await eventsTrigger.getByText('Device Listing Created').getByRole('button').click();
    await expect(eventsTrigger.getByText('Device Listing Created')).toHaveCount(0);

    await eventsTrigger.click();
    await page.getByRole('option', { name: 'Deployment Interrupted' }).click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('option', { name: 'Deployment Interrupted' })).toBeHidden();
    await expect(eventsTrigger.getByText('Deployment Interrupted')).toBeVisible();

    await page.getByRole('button', { name: 'Save Changes' }).click();
    await page.waitForURL(/\/organizations\/webhooks$/);

    const updated = await db.prisma.webhook.findUnique({ where: { id: webhook.id } });
    expect(updated!.endpoint).toBe(updatedEndpoint);
    expect(updated!.description).toBe('After edit');
    expect(updated!.events).toEqual([WebhookEventType.DEPLOYMENT_INTERRUPTED]);
    expect(updated!.isActive).toBe(true);
  });

  test('should soft delete a webhook after endpoint confirmation', async ({ authenticatedPage, db, seedData }) => {
    const page = authenticatedPage;
    const endpoint = `https://example.com/e2e-webhooks/delete-${Date.now()}`;

    const webhook = await db.prisma.webhook.create({
      data: {
        endpoint,
        events: [WebhookEventType.DEVICE_LISTING_UPDATED],
        secret: `e2e-secret-delete-${Date.now()}`,
        organizationId: seedData.organization.id,
      },
    });

    await page.goto(`/organizations/webhooks/delete/${webhook.id}`);
    await expect(page.getByRole('heading', { name: 'Delete Webhook' })).toBeVisible();
    await expect(
      page.getByText('This action cannot be undone. All pending deliveries for this webhook will also be removed.'),
    ).toBeVisible();

    await expect(page.getByRole('button', { name: 'Delete Webhook' })).toBeDisabled();
    await page.getByLabel('Webhook Endpoint').fill(endpoint);
    await expect(page.getByRole('button', { name: 'Delete Webhook' })).toBeEnabled();

    await page.getByRole('button', { name: 'Delete Webhook' }).click();
    await page.waitForURL(/\/organizations\/webhooks$/);

    await expect(page.getByRole('heading', { name: 'No Webhooks' })).toBeVisible();
    await expect(page.getByRole('main').getByText(endpoint)).toBeHidden();

    const deleted = await db.prisma.webhook.findUnique({ where: { id: webhook.id } });
    expect(deleted).not.toBeNull();
    expect(deleted!.deletedAt).not.toBeNull();
  });
});
