import { expect, test } from '../../../fixtures/admin.fixture.js';

const facilityPath = (facilityId: string, suffix = '') => `/api/v1/admin/facilities/${facilityId}${suffix}`;

test.describe.configure({ mode: 'serial' });

test.describe('admin facilities and colocations', () => {
  test('creates a facility, adds a colocation, and lists both', async ({ sitePage, adminSiteSeed }) => {
    const name = `${adminSiteSeed.facility.name} extra`;

    await sitePage.goto('/facilities/create');
    await sitePage.getByLabel('Name').fill(name);
    await sitePage.getByLabel('Operator').fill('Acme Operations');
    await sitePage.getByRole('button', { name: 'Create Facility' }).click();

    await sitePage.waitForURL(/\/facilities\/[0-9a-f-]{36}/);
    await expect(sitePage.getByText(name)).toBeVisible();

    await sitePage.getByRole('tab', { name: 'Colocations' }).click();
    await sitePage.getByRole('link', { name: 'Add Colocation' }).first().click();
    await sitePage.getByLabel('Name').fill('Acme DC9');
    await sitePage.getByRole('button', { name: /Add Colocation|Create/ }).click();

    await expect(sitePage.getByText('Acme DC9')).toBeVisible();
  });

  test('rejects a duplicate facility name case-insensitively', async ({ request, adminSiteSeed }) => {
    const response = await request.post('/api/v1/admin/facilities', {
      data: { name: adminSiteSeed.facility.name.toUpperCase() },
    });

    expect(response.status()).toBe(409);
  });

  test('rejects a duplicate colocation name within the same facility', async ({ request, adminSiteSeed }) => {
    const response = await request.post(facilityPath(adminSiteSeed.facility.id, '/colocations'), {
      data: { name: adminSiteSeed.colocation.name.toLowerCase() },
    });

    expect(response.status()).toBe(409);
  });

  test('adds contacts at both the facility and the colocation level', async ({ sitePage, adminSiteSeed }) => {
    await sitePage.goto(`/facilities/${adminSiteSeed.facility.id}/contacts`);
    await sitePage.getByRole('button', { name: 'Add contact' }).click();
    let dialog = sitePage.getByRole('dialog');
    await dialog.getByLabel('Full name').fill('Ada Lovelace');
    await dialog.getByLabel('Email').fill('ada@example.test');
    await dialog.getByRole('button', { name: 'Add contact' }).click();
    await expect(sitePage.getByText('ada@example.test')).toBeVisible();

    await sitePage.goto(`/facilities/${adminSiteSeed.facility.id}/colocations/${adminSiteSeed.colocation.id}/contacts`);
    await sitePage.getByRole('button', { name: 'Add contact' }).click();
    dialog = sitePage.getByRole('dialog');
    await dialog.getByLabel('Full name').fill('Grace Hopper');
    await dialog.getByLabel('Email').fill('grace@example.test');
    await dialog.getByRole('button', { name: 'Add contact' }).click();
    await expect(sitePage.getByText('grace@example.test')).toBeVisible();
  });

  test('blocks deleting a facility while it still has colocations', async ({ request, adminSiteSeed }) => {
    const response = await request.delete(facilityPath(adminSiteSeed.facility.id));

    expect(response.status()).toBe(409);
    expect(await response.text()).toContain('colocation');
  });

  test('blocks deleting a colocation while it still has contacts', async ({ request, adminSiteSeed }) => {
    const response = await request.delete(
      facilityPath(adminSiteSeed.facility.id, `/colocations/${adminSiteSeed.colocation.id}`),
    );

    expect(response.status()).toBe(409);
    expect(await response.text()).toContain('contact');
  });

  test('attaches a zone, then demands confirmMove to move it elsewhere', async ({
    request,
    adminSiteSeed,
    adminSeed,
  }) => {
    const attach = await request.post(
      facilityPath(adminSiteSeed.facility.id, `/colocations/${adminSiteSeed.colocation.id}/zones`),
      { data: { zoneId: adminSeed.zoneId } },
    );
    expect(attach.status()).toBe(200);

    const unconfirmed = await request.post(
      facilityPath(adminSiteSeed.facility.id, `/colocations/${adminSiteSeed.otherColocation.id}/zones`),
      { data: { zoneId: adminSeed.zoneId } },
    );
    expect(unconfirmed.status()).toBe(409);
    expect(await unconfirmed.json()).toMatchObject({
      colocationId: adminSiteSeed.colocation.id,
      colocationName: adminSiteSeed.colocation.name,
      facilityName: adminSiteSeed.facility.name,
    });

    const confirmed = await request.post(
      facilityPath(adminSiteSeed.facility.id, `/colocations/${adminSiteSeed.otherColocation.id}/zones`),
      { data: { zoneId: adminSeed.zoneId, confirmMove: true } },
    );
    expect(confirmed.status()).toBe(200);
  });

  test('blocks deleting a colocation while zones are still attached', async ({ request, adminSiteSeed }) => {
    const response = await request.delete(
      facilityPath(adminSiteSeed.facility.id, `/colocations/${adminSiteSeed.otherColocation.id}`),
    );

    expect(response.status()).toBe(409);
    expect(await response.text()).toContain('zone');
  });

  test('404s detaching a zone through a sibling colocation', async ({ request, adminSiteSeed, adminSeed }) => {
    const response = await request.delete(
      facilityPath(adminSiteSeed.facility.id, `/colocations/${adminSiteSeed.colocation.id}/zones/${adminSeed.zoneId}`),
    );

    expect(response.status()).toBe(404);
  });
});
