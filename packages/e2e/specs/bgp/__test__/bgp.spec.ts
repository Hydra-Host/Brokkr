import { expect, test } from '../../../fixtures/auth.fixture.js';

test.describe('BGP - Peer Groups', () => {
  test('should display peer groups list page', async ({ authenticatedPage }) => {
    await authenticatedPage.goto('/bgp/peer-groups');
    await expect(authenticatedPage.getByText('Peer Groups').first()).toBeVisible();
    await expect(authenticatedPage.getByRole('link', { name: 'Create Peer Group' })).toBeVisible();
  });
});

test.describe('BGP - Prefix Lists', () => {
  test('should display prefix lists page', async ({ authenticatedPage }) => {
    await authenticatedPage.goto('/bgp/prefix-lists');
    await expect(authenticatedPage.getByText('Prefix Lists').first()).toBeVisible();
    await expect(authenticatedPage.getByRole('link', { name: 'Create Prefix List' })).toBeVisible();
  });
});

test.describe('BGP - Prefix List Rules', () => {
  test('should display prefix list rules page', async ({ authenticatedPage }) => {
    await authenticatedPage.goto('/bgp/prefix-list-rules');
    await expect(authenticatedPage.getByText('Prefix List Rules').first()).toBeVisible();
    await expect(authenticatedPage.getByRole('link', { name: 'Create Rule' })).toBeVisible();
  });
});

test.describe('BGP - Sessions', () => {
  test('should display sessions list page', async ({ authenticatedPage }) => {
    await authenticatedPage.goto('/bgp/sessions');
    await expect(authenticatedPage.getByText('BGP Sessions').first()).toBeVisible();
    await expect(authenticatedPage.getByRole('link', { name: 'Create BGP Session' })).toBeVisible();
  });
});
