import { expect, test } from '../../../fixtures/auth.fixture.js';

test.describe('DCIM - Rack Roles', () => {
  test('should display rack roles page without operator mutations', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    await page.goto('/dcim/rack-roles');
    await expect(page.getByText('Rack Roles').first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Create Rack Role' })).toHaveCount(0);
  });
});

test.describe('DCIM - Racks', () => {
  test('should display racks list page', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    await page.goto('/dcim/racks');
    await expect(page.getByText('Racks').first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Create Rack' })).toBeVisible();
  });
});

test.describe('DCIM - Interfaces', () => {
  test('should display interfaces list page', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    await page.goto('/dcim/interfaces');
    await expect(page.getByText('Interfaces').first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Create Interface' })).toBeVisible();
  });
});

test.describe('DCIM - Cables', () => {
  test('should display cables list page', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    await page.goto('/dcim/cables');
    await expect(page.getByText('Cables').first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Create Cable' })).toBeVisible();
  });
});

test.describe('DCIM - Console Ports', () => {
  test('should display console ports list page', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    await page.goto('/dcim/console-ports');
    await expect(page.getByText('Console Ports').first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Create Console Port' })).toBeVisible();
  });
});

test.describe('DCIM - Console Server Ports', () => {
  test('should display console server ports list page', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    await page.goto('/dcim/console-server-ports');
    await expect(page.getByText('Console Server Ports').first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Create Console Server Port' })).toBeVisible();
  });
});

test.describe('DCIM - Power Ports', () => {
  test('should display power ports list page', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    await page.goto('/dcim/power-ports');
    await expect(page.getByText('Power Ports').first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Create Power Port' })).toBeVisible();
  });
});

test.describe('DCIM - Power Outlets', () => {
  test('should display power outlets list page', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    await page.goto('/dcim/power-outlets');
    await expect(page.getByText('Power Outlets').first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Create Power Outlet' })).toBeVisible();
  });
});

test.describe('DCIM - Front Ports', () => {
  test('should display front ports list page', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    await page.goto('/dcim/front-ports');
    await expect(page.getByText('Front Ports').first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Create Front Port' })).toBeVisible();
  });
});

test.describe('DCIM - Rear Ports', () => {
  test('should display rear ports list page', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    await page.goto('/dcim/rear-ports');
    await expect(page.getByText('Rear Ports').first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Create Rear Port' })).toBeVisible();
  });
});

test.describe('DCIM - Rack Roles authorization', () => {
  test('should hide operator-only rack role mutations', async ({ supplyAuthenticatedPage }) => {
    const page = supplyAuthenticatedPage;

    await page.goto('/dcim/rack-roles');
    await expect(page.getByText('Rack Roles').first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Create Rack Role' })).toHaveCount(0);

    await page.goto('/dcim/rack-roles/create');
    await expect(page).toHaveURL(/\/dcim\/rack-roles$/);
    await expect(page.getByRole('button', { name: 'Create Rack Role' })).toHaveCount(0);
  });
});
