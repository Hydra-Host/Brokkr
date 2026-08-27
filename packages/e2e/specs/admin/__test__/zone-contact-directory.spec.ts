import { expect, relatedContactsCard, test } from '../../../fixtures/admin.fixture.js';

test.describe.configure({ mode: 'serial' });

test.describe('zone contact directory', () => {
  test('explains the empty state for a zone with no colocation', async ({ sitePage, adminSeed, adminDb }) => {
    await adminDb.prisma.zone.update({ where: { id: adminSeed.zoneId }, data: { colocationId: null } });

    await sitePage.goto(`/zones/${adminSeed.zoneId}`);
    const card = relatedContactsCard(sitePage);

    await expect(card).toBeVisible();
    await expect(card.getByText('not attached to a colocation')).toBeVisible();
    await expect(card.getByRole('link', { name: 'Facilities' })).toBeVisible();
  });

  test('shows every level under the zone once it is attached', async ({
    sitePage,
    adminSeed,
    adminSiteSeed,
    adminDb,
  }) => {
    await adminDb.prisma.zone.update({
      where: { id: adminSeed.zoneId },
      data: { colocationId: adminSiteSeed.colocation.id },
    });
    await adminDb.prisma.contact.createMany({
      data: [
        { name: 'Colo NOC', email: 'colo-noc@example.test', colocationId: adminSiteSeed.colocation.id },
        { name: 'Facility Upstream', email: 'upstream@example.test', facilityId: adminSiteSeed.facility.id },
      ],
    });

    await sitePage.goto(`/zones/${adminSeed.zoneId}`);
    const card = relatedContactsCard(sitePage);

    await expect(card.getByText(adminSiteSeed.colocation.name)).toBeVisible();
    await expect(card.getByText('colo-noc@example.test')).toBeVisible();
    await expect(card.getByText(adminSiteSeed.facility.name).first()).toBeVisible();
    await expect(card.getByText('upstream@example.test')).toBeVisible();
  });

  test('offers no edit or delete affordance on an inherited contact', async ({
    sitePage,
    adminSeed,
    adminSiteSeed,
    adminDb,
  }) => {
    await adminDb.prisma.zone.update({
      where: { id: adminSeed.zoneId },
      data: { colocationId: adminSiteSeed.colocation.id },
    });

    await sitePage.goto(`/zones/${adminSeed.zoneId}`);
    const card = relatedContactsCard(sitePage);
    await expect(card).toBeVisible();

    await expect(card.getByRole('button', { name: /edit/i })).toHaveCount(0);
    await expect(card.getByRole('button', { name: /delete/i })).toHaveCount(0);
    await expect(card.getByRole('button', { name: /add contact/i })).toHaveCount(0);
    await expect(card.getByRole('menuitem')).toHaveCount(0);
  });

  test('links each section to the record that owns those contacts', async ({
    sitePage,
    adminSeed,
    adminSiteSeed,
    adminDb,
  }) => {
    await adminDb.prisma.zone.update({
      where: { id: adminSeed.zoneId },
      data: { colocationId: adminSiteSeed.colocation.id },
    });

    await sitePage.goto(`/zones/${adminSeed.zoneId}`);
    const card = relatedContactsCard(sitePage);

    await card.getByRole('link', { name: `Manage in ${adminSiteSeed.facility.name}` }).click();
    await expect(sitePage).toHaveURL(new RegExp(`/facilities/${adminSiteSeed.facility.id}/contacts`));
  });

  test('shows the site attachment in Zone Info', async ({ sitePage, adminSeed, adminSiteSeed, adminDb }) => {
    await adminDb.prisma.zone.update({
      where: { id: adminSeed.zoneId },
      data: { colocationId: adminSiteSeed.colocation.id },
    });

    await sitePage.goto(`/zones/${adminSeed.zoneId}`);
    const zoneInfo = sitePage.locator('[data-slot="card"]').filter({ hasText: 'Zone Info' });

    await expect(zoneInfo.getByText('Site')).toBeVisible();
    await expect(zoneInfo.getByRole('link', { name: adminSiteSeed.colocation.name })).toBeVisible();
  });

  test('returns the directory over the API with one group per level', async ({
    request,
    adminSeed,
    adminSiteSeed,
    adminDb,
  }) => {
    await adminDb.prisma.zone.update({
      where: { id: adminSeed.zoneId },
      data: { colocationId: adminSiteSeed.colocation.id },
    });

    const response = await request.get(`/api/v1/admin/zones/${adminSeed.zoneId}/contact-directory`);

    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.groups.map((g: { source: string }) => g.source)).toEqual([
      'zone',
      'colocation',
      'facility',
      'organization',
    ]);
    expect(body.site).toMatchObject({
      colocation: { id: adminSiteSeed.colocation.id },
      facility: { id: adminSiteSeed.facility.id },
    });
  });
});
