import { expect, test } from '../../../fixtures/auth.fixture.js';

test.describe('Tags CRUD', () => {
  test('should display tags list page', async ({ authenticatedPage, db, seedData }) => {
    const page = authenticatedPage;

    const seededTag = await db.prisma.tag.create({
      data: {
        name: `list-test-${Date.now()}`,
        color: '#ff0000',
        description: 'Tag for list test',
        organizationId: seedData.organization.id,
      },
    });

    await page.goto('/tags');
    await expect(page.getByText('Tags').first()).toBeVisible();
    await expect(page.getByText('Manage tags for organizing resources.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Create Tag' })).toBeVisible();

    await db.prisma.tag.delete({ where: { id: seededTag.id } });
  });

  test('should create a new tag', async ({ authenticatedPage, db, seedData }) => {
    const page = authenticatedPage;
    const tagName = `e2e-create-${Date.now()}`;

    await page.goto('/tags/create');
    await expect(page.getByText('Tag Details')).toBeVisible();

    await page.getByLabel('Name').fill(tagName);
    await page.getByLabel('Color').fill('#00ff00');
    await page.getByLabel('Description').fill('Created by E2E test');

    await page.getByRole('button', { name: 'Create Tag' }).click();

    await page.waitForURL(/\/tags$/);

    const tag = await db.prisma.tag.findFirst({
      where: { name: tagName, organizationId: seedData.organization.id },
    });
    expect(tag).not.toBeNull();
    expect(tag!.color).toBe('#00ff00');
    expect(tag!.description).toBe('Created by E2E test');

    await db.prisma.tag.delete({ where: { id: tag!.id } });
  });

  test('should view tag detail page', async ({ authenticatedPage, db, seedData }) => {
    const page = authenticatedPage;

    const tag = await db.prisma.tag.create({
      data: {
        name: `e2e-detail-${Date.now()}`,
        color: '#0000ff',
        description: 'Detail test tag',
        organizationId: seedData.organization.id,
      },
    });

    await page.goto(`/tags/${tag.id}`);

    await expect(page.getByText(tag.name).first()).toBeVisible();

    await expect(page.getByText('Details').first()).toBeVisible();
    await expect(page.getByText('Metadata')).toBeVisible();

    await expect(page.getByRole('link', { name: 'Edit' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Delete' })).toBeVisible();

    await db.prisma.tag.delete({ where: { id: tag.id } });
  });

  test('should edit an existing tag', async ({ authenticatedPage, db, seedData }) => {
    const page = authenticatedPage;

    const tag = await db.prisma.tag.create({
      data: {
        name: `e2e-edit-${Date.now()}`,
        color: '#ff0000',
        description: 'Before edit',
        organizationId: seedData.organization.id,
      },
    });

    await page.goto(`/tags/${tag.id}/edit`);
    await expect(page.getByText('Edit Tag').first()).toBeVisible();

    await page.getByLabel('Name').clear();
    await page.getByLabel('Name').fill(`${tag.name}-updated`);
    await page.getByLabel('Description').clear();
    await page.getByLabel('Description').fill('After edit');

    await page.getByRole('button', { name: 'Save Changes' }).click();

    await page.waitForURL(new RegExp(`/tags/${tag.id}$`));

    const updated = await db.prisma.tag.findUnique({ where: { id: tag.id } });
    expect(updated!.name).toBe(`${tag.name}-updated`);
    expect(updated!.description).toBe('After edit');

    await db.prisma.tag.delete({ where: { id: tag.id } });
  });

  test('should delete a tag', async ({ authenticatedPage, db, seedData }) => {
    const page = authenticatedPage;

    const tag = await db.prisma.tag.create({
      data: {
        name: `e2e-delete-${Date.now()}`,
        organizationId: seedData.organization.id,
      },
    });

    await page.goto(`/tags/${tag.id}/delete`);

    await expect(page.getByText(`Delete Tag: ${tag.name}`)).toBeVisible();
    await expect(page.getByText('This action cannot be undone.')).toBeVisible();

    await page.getByRole('button', { name: 'Delete Tag' }).click();

    await page.waitForURL(/\/tags$/);

    const deleted = await db.prisma.tag.findUnique({ where: { id: tag.id } });
    expect(deleted).toBeNull();
  });
});
