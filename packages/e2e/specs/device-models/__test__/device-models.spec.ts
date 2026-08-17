import { expect, test } from '../../../fixtures/auth.fixture.js';

test.describe('Device Models CRUD', () => {
  test('should display device models list page', async ({ authenticatedPage, db }) => {
    const page = authenticatedPage;

    const seeded = await db.prisma.deviceModel.create({
      data: { manufacturer: `E2E-List-${Date.now()}`, model: 'TestModel', formFactor: '2U', heightU: 2 },
    });

    await page.goto('/device-models');
    await expect(page.getByText('Device Models').first()).toBeVisible();
    await expect(page.getByText('Hardware device model definitions.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Create Device Model' })).toBeVisible();

    await db.prisma.deviceModel.delete({ where: { id: seeded.id } });
  });

  test('should create a new device model', async ({ authenticatedPage, db }) => {
    const page = authenticatedPage;
    const manufacturer = `E2E-Create-${Date.now()}`;

    await page.goto('/device-models/create');
    await expect(page.getByText('Device Model Details')).toBeVisible();

    await page.getByLabel('Manufacturer').fill(manufacturer);
    await page.getByLabel('Model').fill('GPU-Server-X');
    await page.getByLabel('Form Factor').fill('2U');
    await page.getByLabel('Description').fill('Created by E2E');
    await page.getByLabel('Height (U)').fill('2');
    await page.getByLabel('Max Power (W)').fill('1500');

    await page.getByRole('button', { name: 'Create Device Model' }).click();
    await page.waitForURL(/\/device-models$/);

    const dm = await db.prisma.deviceModel.findFirst({ where: { manufacturer } });
    expect(dm).not.toBeNull();
    expect(dm!.model).toBe('GPU-Server-X');
    expect(dm!.formFactor).toBe('2U');
    expect(dm!.heightU).toBe(2);
    expect(dm!.maxPowerW).toBe(1500);

    await db.prisma.deviceModel.delete({ where: { id: dm!.id } });
  });

  test('should view device model detail page', async ({ authenticatedPage, db }) => {
    const page = authenticatedPage;

    const dm = await db.prisma.deviceModel.create({
      data: {
        manufacturer: `E2E-Detail-${Date.now()}`,
        model: 'DetailModel',
        formFactor: '1U',
        heightU: 1,
        maxPowerW: 750,
      },
    });

    await page.goto(`/device-models/${dm.id}`);

    await expect(page.getByText(`${dm.manufacturer} ${dm.model}`).first()).toBeVisible();
    await expect(page.getByText('Details').first()).toBeVisible();
    await expect(page.getByText('Specifications')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Edit' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Delete' })).toBeVisible();

    await db.prisma.deviceModel.delete({ where: { id: dm.id } });
  });

  test('should edit an existing device model', async ({ authenticatedPage, db }) => {
    const page = authenticatedPage;

    const dm = await db.prisma.deviceModel.create({
      data: { manufacturer: `E2E-Edit-${Date.now()}`, model: 'BeforeEdit', formFactor: '1U' },
    });

    await page.goto(`/device-models/${dm.id}/edit`);
    await expect(page.getByText('Edit Device Model').first()).toBeVisible();

    await page.getByLabel('Model').clear();
    await page.getByLabel('Model').fill('AfterEdit');
    await page.getByLabel('Description').fill('Updated by E2E');

    await page.getByRole('button', { name: 'Save Changes' }).click();
    await page.waitForURL(new RegExp(`/device-models/${dm.id}$`));

    const updated = await db.prisma.deviceModel.findUnique({ where: { id: dm.id } });
    expect(updated!.model).toBe('AfterEdit');
    expect(updated!.description).toBe('Updated by E2E');

    await db.prisma.deviceModel.delete({ where: { id: dm.id } });
  });

  test('should delete a device model', async ({ authenticatedPage, db }) => {
    const page = authenticatedPage;

    const dm = await db.prisma.deviceModel.create({
      data: { manufacturer: `E2E-Delete-${Date.now()}`, model: 'ToDelete' },
    });

    await page.goto(`/device-models/${dm.id}/delete`);
    await expect(page.getByText(`Delete: ${dm.manufacturer} ${dm.model}`)).toBeVisible();

    await page.getByRole('button', { name: 'Delete' }).click();
    await page.waitForURL(/\/device-models$/);

    const deleted = await db.prisma.deviceModel.findUnique({ where: { id: dm.id } });
    expect(deleted).toBeNull();
  });
});
