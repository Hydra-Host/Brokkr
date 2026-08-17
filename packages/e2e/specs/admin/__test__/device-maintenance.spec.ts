import {
  activeWindowSummary,
  errorToast,
  expect,
  maintenanceCard,
  maintenanceHistoryRows,
  MEMBER_USER,
  OWNER_EMAIL,
  test,
} from '../../../fixtures/admin.fixture.js';

const REASON = 'DIMM replacement on slot A2';
const CUSTOMER_MESSAGE = 'This host is undergoing scheduled hardware maintenance.';
const UPDATED_REASON = 'DIMM replacement on slot A2 - extended, awaiting part';

const maintenancePath = (deviceId: string, suffix = '') => `/api/v1/admin/servers/${deviceId}/maintenance${suffix}`;

test.describe.configure({ mode: 'serial' });

test.describe('admin device maintenance', () => {
  test('opens, updates, and closes a maintenance window from the server detail card', async ({
    adminPage,
    adminSeed,
    adminDb,
  }) => {
    const card = maintenanceCard(adminPage);

    await expect(
      card.getByText('Open a maintenance window on this device, independent of its data center.'),
    ).toBeVisible();
    await expect(card.getByRole('link', { name: 'Enable Maintenance' })).toBeVisible();
    await expect(card.getByText('No maintenance history for this device.')).toBeVisible();

    await card.getByRole('link', { name: 'Enable Maintenance' }).click();
    const enableDialog = adminPage.getByRole('dialog');
    await expect(enableDialog.getByText('Enable Device Maintenance')).toBeVisible();
    await enableDialog.getByLabel('Reason (internal)').fill(REASON);
    await enableDialog.getByLabel('Customer message (optional)').fill(CUSTOMER_MESSAGE);
    await enableDialog.getByRole('button', { name: 'Enable Maintenance' }).click();

    await expect(adminPage).toHaveURL(new RegExp(`/servers/${adminSeed.device.id}$`));
    await expect(card.getByText('This device is in a maintenance window.')).toBeVisible();
    const summary = activeWindowSummary(adminPage);
    await expect(summary.getByText(REASON, { exact: true })).toBeVisible();
    await expect(summary.getByText('TBD')).toBeVisible();
    await expect(summary.getByText(OWNER_EMAIL)).toBeVisible();
    await expect(maintenanceHistoryRows(adminPage).first()).toContainText('Active');
    expect(await adminDb.activeMaintenanceCount(adminSeed.device.id)).toBe(1);

    await card.getByRole('link', { name: 'Update' }).click();
    const updateDialog = adminPage.getByRole('dialog');
    await expect(updateDialog.getByLabel('Reason (internal)')).toHaveValue(REASON);
    await expect(updateDialog.getByLabel('Customer message (optional)')).toHaveValue(CUSTOMER_MESSAGE);
    await updateDialog.getByLabel('Reason (internal)').fill(UPDATED_REASON);
    await updateDialog.getByRole('button', { name: 'Update Maintenance' }).click();

    await expect(summary.getByText(UPDATED_REASON, { exact: true })).toBeVisible();
    expect(await adminDb.activeMaintenanceCount(adminSeed.device.id)).toBe(1);

    await card.getByRole('link', { name: 'Disable Maintenance' }).click();
    const disableDialog = adminPage.getByRole('alertdialog');
    await expect(disableDialog.getByText(UPDATED_REASON)).toBeVisible();
    await disableDialog.getByRole('button', { name: 'Disable Maintenance' }).click();

    await expect(
      card.getByText('Open a maintenance window on this device, independent of its data center.'),
    ).toBeVisible();
    await expect(card.getByRole('link', { name: 'Enable Maintenance' })).toBeVisible();
    expect(await adminDb.activeMaintenanceCount(adminSeed.device.id)).toBe(0);
  });

  test('lists closed and open windows in the history table, newest first', async ({
    adminPage,
    adminSeed,
    request,
  }) => {
    const before = await maintenanceHistoryRows(adminPage).count();

    await request.post(maintenancePath(adminSeed.device.id, '/enable'), { data: { reason: 'PSU swap' } });
    await request.post(maintenancePath(adminSeed.device.id, '/disable'), { data: {} });
    await request.post(maintenancePath(adminSeed.device.id, '/enable'), { data: { reason: 'Backplane swap' } });

    await adminPage.reload();

    const rows = maintenanceHistoryRows(adminPage);
    await expect(rows).toHaveCount(before + 2);
    await expect(rows.nth(0)).toContainText('Backplane swap');
    await expect(rows.nth(0)).toContainText('Active');
    await expect(rows.nth(1)).toContainText('PSU swap');
    await expect(rows.nth(1)).not.toContainText('Active');

    await request.post(maintenancePath(adminSeed.device.id, '/disable'), { data: {} });
  });

  test('surfaces a 409 instead of silently opening a second window', async ({ adminPage, adminSeed, request }) => {
    const opened = await request.post(maintenancePath(adminSeed.device.id, '/enable'), {
      data: { reason: 'first window' },
    });
    expect(opened.status()).toBe(200);

    const conflict = await request.post(maintenancePath(adminSeed.device.id, '/enable'), {
      data: { reason: 'second window' },
    });
    expect(conflict.status()).toBe(409);
    expect(await conflict.json()).toMatchObject({ message: 'Device is already in maintenance' });

    await adminPage.goto(`/servers/${adminSeed.device.id}/maintenance-enable`);
    const dialog = adminPage.getByRole('dialog');
    await dialog.getByLabel('Reason (internal)').fill('duplicate window via UI');
    await dialog.getByRole('button', { name: 'Enable Maintenance' }).click();

    await expect(errorToast(adminPage, 'Device is already in maintenance')).toBeVisible();
    await expect(dialog).toBeVisible();
    await expect(adminPage).toHaveURL(/maintenance-enable$/);

    await request.post(maintenancePath(adminSeed.device.id, '/disable'), { data: {} });
  });

  test('404s for an unknown device and for a close with no open window', async ({ adminSeed, request }) => {
    const ghostId = '99999999-9999-4999-8999-999999999999';

    expect((await request.get(maintenancePath(ghostId))).status()).toBe(404);
    const ghostEnable = await request.post(maintenancePath(ghostId, '/enable'), { data: { reason: 'ghost' } });
    expect(ghostEnable.status()).toBe(404);
    expect(await ghostEnable.json()).toMatchObject({ message: 'Device not found' });

    const disable = await request.post(maintenancePath(adminSeed.device.id, '/disable'), { data: {} });
    expect(disable.status()).toBe(404);
    expect(await disable.json()).toMatchObject({ message: 'No active maintenance found for this device' });

    const update = await request.patch(maintenancePath(adminSeed.device.id), { data: { reason: 'nothing open' } });
    expect(update.status()).toBe(404);
  });

  test(`grants ${MEMBER_USER.email} reads but denies every mutation`, async ({ adminSeed, memberRequest }) => {
    const deviceId = adminSeed.device.id;

    expect((await memberRequest.get(maintenancePath(deviceId))).status()).toBe(200);
    expect((await memberRequest.get(maintenancePath(deviceId, '/history'))).status()).toBe(200);

    const enable = await memberRequest.post(maintenancePath(deviceId, '/enable'), { data: { reason: 'member' } });
    expect(enable.status()).toBe(403);
    expect((await memberRequest.patch(maintenancePath(deviceId), { data: { reason: 'member' } })).status()).toBe(403);
    expect((await memberRequest.post(maintenancePath(deviceId, '/disable'), { data: {} })).status()).toBe(403);
  });
});

test.describe('admin zone maintenance', () => {
  test('still opens and closes from the zone detail card', async ({ adminPage, adminSeed }) => {
    await adminPage.goto(`/zones/${adminSeed.zoneId}`);
    const card = adminPage.locator('[data-slot="card"]').filter({ hasText: 'Maintenance Mode' });

    await card.getByRole('link', { name: 'Enable Maintenance' }).click();
    const dialog = adminPage.getByRole('dialog');
    await dialog.getByLabel('Reason (internal)').fill('zone regression check');
    await dialog.getByRole('button', { name: 'Enable Maintenance' }).click();

    await expect(card.getByText('This zone is currently in maintenance.')).toBeVisible();

    await card.getByRole('link', { name: 'Disable Maintenance' }).first().click();
    await adminPage.getByRole('alertdialog').getByRole('button', { name: 'Disable Maintenance' }).click();

    await expect(
      card.getByText('Enable maintenance mode to isolate this zone from customer operations.'),
    ).toBeVisible();
  });
});
