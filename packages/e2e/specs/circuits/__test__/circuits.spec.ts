import { expect, test } from '../../../fixtures/auth.fixture.js';

test.describe('Circuits - Providers', () => {
  test('should display providers list page', async ({ authenticatedPage }) => {
    await authenticatedPage.goto('/circuits/providers');
    await expect(authenticatedPage.getByText('Providers').first()).toBeVisible();
    await expect(authenticatedPage.getByRole('link', { name: 'Create Provider' })).toBeVisible();
  });
});

test.describe('Circuits - Provider Networks', () => {
  test('should display provider networks list page', async ({ authenticatedPage }) => {
    await authenticatedPage.goto('/circuits/provider-networks');
    await expect(authenticatedPage.getByText('Provider Networks').first()).toBeVisible();
    await expect(authenticatedPage.getByRole('link', { name: 'Create Provider Network' })).toBeVisible();
  });
});

test.describe('Circuits - Circuit Types', () => {
  test('should display circuit types list page', async ({ authenticatedPage }) => {
    await authenticatedPage.goto('/circuits/circuit-types');
    await expect(authenticatedPage.getByText('Circuit Types').first()).toBeVisible();
    await expect(authenticatedPage.getByRole('link', { name: 'Create Circuit Type' })).toBeVisible();
  });
});

test.describe('Circuits - Circuits', () => {
  test('should display circuits list page', async ({ authenticatedPage }) => {
    await authenticatedPage.goto('/circuits/circuits');
    await expect(authenticatedPage.getByText('Circuits').first()).toBeVisible();
    await expect(authenticatedPage.getByRole('link', { name: 'Create Circuit' })).toBeVisible();
  });
});

test.describe('Circuits - Circuit Terminations', () => {
  test('should display circuit terminations list page', async ({ authenticatedPage }) => {
    await authenticatedPage.goto('/circuits/circuit-terminations');
    await expect(authenticatedPage.getByText('Circuit Terminations').first()).toBeVisible();
    await expect(authenticatedPage.getByRole('link', { name: 'Create Termination' })).toBeVisible();
  });
});
