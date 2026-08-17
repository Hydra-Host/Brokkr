import type { PrismaClient } from '@repo/database';
import { expect, test } from '../../../fixtures/auth.fixture.js';


interface SeedContactInput {
  name: string;
  contactType: 'Main' | 'Technical';
  isShippingContact: boolean;
}

const seedZone = async (prisma: PrismaClient, organizationId: string, name: string, contacts: SeedContactInput[]) =>
  prisma.zone.create({
    data: {
      name,
      organization: { connect: { id: organizationId } },
      addresses: {
        create: [
          {
            type: 'PRIMARY',
            formattedAddress: '1 Seed Way, Testville, CA 94000, United States',
            addressLineOne: '1 Seed Way',
            city: 'Testville',
            stateOrProvince: 'CA',
            postalCode: '94000',
            country: 'United States',
            countryCode: 'US',
            timezone: 'America/Los_Angeles',
          },
        ],
      },
      contacts: {
        create: contacts.map((contact) => ({
          name: contact.name,
          title: 'Site Manager',
          email: 'seed-contact@test.brokkr.local',
          phone: '+12125551234',
          contactType: contact.contactType,
          isShippingContact: contact.isShippingContact,
        })),
      },
    },
    include: { addresses: true, contacts: true },
  });

test.describe('Zones CRUD', () => {
  test.afterEach(async ({ db, seedData }) => {
    await db.prisma.zone.deleteMany({
      where: { organizationId: seedData.organization.id, name: { startsWith: 'e2e-zone-' } },
    });
  });

  test('should display zones list with a seeded zone', async ({ authenticatedPage, db, seedData }) => {
    const page = authenticatedPage;
    const zoneName = `e2e-zone-list-${Date.now()}`;

    const zone = await seedZone(db.prisma, seedData.organization.id, zoneName, [
      { name: 'List Contact', contactType: 'Main', isShippingContact: true },
    ]);

    await page.goto('/dcim/zones');
    await expect(page.getByText('Zones').first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Create Zone' })).toBeVisible();

    await page.getByLabel('Search zones').fill(zoneName);
    await page.waitForURL((url) => url.searchParams.get('search') === zoneName);
    await expect(page.getByRole('link', { name: zoneName })).toBeVisible();
    await expect(page.getByText('Testville, CA, US').first()).toBeVisible();

    await db.prisma.zone.delete({ where: { id: zone.id } });
  });

  test('should create a zone via the create form', async ({ authenticatedPage, db, seedData }) => {
    const page = authenticatedPage;
    const zoneName = `e2e-zone-create-${Date.now()}`;

    await page.goto('/dcim/zones/create');
    await expect(page.getByText('Basic information about your zone.')).toBeVisible();

    await page.getByLabel('Zone Name').fill(zoneName);

    await page.getByLabel('Address Line 1').fill('100 E2E Street');
    await page.getByLabel('City').fill('San Francisco');
    await page.getByLabel('State / Province').fill('CA');
    await page.getByLabel('ZIP / Postal Code').fill('94102');
    await page.getByLabel('Country').click();
    await page.getByRole('option', { name: 'United States', exact: true }).click();
    await page.getByLabel('Latitude').fill('37.7749');
    await page.getByLabel('Longitude').fill('-122.4194');

    await page.getByLabel('Full Name').fill('E2E Zone Contact');
    await page.getByLabel('Title').fill('Site Manager');
    await page.getByLabel('Email').fill('zone-contact@test.brokkr.local');
    await page.getByLabel('Phone').fill('2125551234');

    await page.getByRole('button', { name: 'Create Zone' }).click();
    await page.waitForURL(/\/dcim\/zones$/);

    const zone = await db.prisma.zone.findFirst({
      where: { name: zoneName, organizationId: seedData.organization.id },
      include: { addresses: true, contacts: true },
    });
    expect(zone).not.toBeNull();
    expect(zone!.uuidSuffix).toBe(zone!.id.slice(-5));

    const primary = zone!.addresses.find((address) => address.type === 'PRIMARY');
    expect(primary).toBeDefined();
    expect(primary!.addressLineOne).toBe('100 E2E Street');
    expect(primary!.city).toBe('San Francisco');
    expect(primary!.stateOrProvince).toBe('CA');
    expect(primary!.postalCode).toBe('94102');
    expect(primary!.countryCode).toBe('US');
    expect(primary!.country).toBe('United States');
    expect(primary!.formattedAddress).toBe('100 E2E Street, San Francisco, CA 94102, United States');
    expect(primary!.latitude).toBeCloseTo(37.7749);
    expect(primary!.longitude).toBeCloseTo(-122.4194);
    expect(zone!.addresses.filter((address) => address.type === 'SHIPPING')).toHaveLength(0);

    expect(zone!.contacts).toHaveLength(1);
    const zoneContact = zone!.contacts[0];
    expect(zoneContact).toBeDefined();
    expect(zoneContact!.name).toBe('E2E Zone Contact');
    expect(zoneContact!.title).toBe('Site Manager');
    expect(zoneContact!.email).toBe('zone-contact@test.brokkr.local');
    expect(zoneContact!.phone).toBe('+12125551234');
    expect(zoneContact!.contactType).toBe('Main');
    expect(zoneContact!.isShippingContact).toBe(true);

    await db.prisma.zone.delete({ where: { id: zone!.id } });
  });

  test('should edit the zone name', async ({ authenticatedPage, db, seedData }) => {
    const page = authenticatedPage;
    const zoneName = `e2e-zone-edit-${Date.now()}`;

    const zone = await seedZone(db.prisma, seedData.organization.id, zoneName, [
      { name: 'Edit Contact', contactType: 'Main', isShippingContact: true },
    ]);

    await page.goto(`/dcim/zones/${zone.id}/edit`);
    await expect(page.getByRole('heading', { name: 'Edit Zone' })).toBeVisible();

    await page.getByLabel('Zone Name').clear();
    await page.getByLabel('Zone Name').fill(`${zoneName}-renamed`);
    await page.getByRole('button', { name: 'Save Changes' }).click();

    await page.waitForURL(new RegExp(`/dcim/zones/${zone.id}$`));

    const updated = await db.prisma.zone.findUnique({ where: { id: zone.id } });
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe(`${zoneName}-renamed`);

    await db.prisma.zone.delete({ where: { id: zone.id } });
  });

  test('should add a contact to a zone', async ({ authenticatedPage, db, seedData }) => {
    const page = authenticatedPage;
    const zoneName = `e2e-zone-contact-add-${Date.now()}`;
    const contactName = `e2e-added-contact-${Date.now()}`;

    const zone = await seedZone(db.prisma, seedData.organization.id, zoneName, [
      { name: 'Existing Contact', contactType: 'Main', isShippingContact: true },
    ]);

    await page.goto(`/dcim/zones/${zone.id}/contacts/create`);
    await expect(page.getByRole('heading', { name: 'Add New Contact' })).toBeVisible();

    await page.getByLabel('Full Name').fill(contactName);
    await page.getByLabel('Title').fill('Network Engineer');
    await page.getByLabel('Contact Type').click();
    await page.getByRole('option', { name: 'Technical', exact: true }).click();
    await page.getByLabel('Email').fill('added-contact@test.brokkr.local');
    await page.getByLabel('Phone').fill('2125556789');

    await page.getByRole('button', { name: 'Add Contact' }).click();
    await page.waitForURL(new RegExp(`/dcim/zones/${zone.id}$`));

    // Verify in DB
    const contact = await db.prisma.contact.findFirst({
      where: { zoneId: zone.id, name: contactName, deletedAt: null },
    });
    expect(contact).not.toBeNull();
    expect(contact!.title).toBe('Network Engineer');
    expect(contact!.email).toBe('added-contact@test.brokkr.local');
    expect(contact!.phone).toBe('+12125556789');
    expect(contact!.contactType).toBe('Technical');
    expect(contact!.isShippingContact).toBe(false);
    // Shared Contact table: a zone contact sets only zoneId (exactly-one-parent CHECK).
    expect(contact!.organizationId).toBeNull();
    expect(contact!.manufacturerId).toBeNull();

    await expect(page.getByText(contactName)).toBeVisible();

    await db.prisma.zone.delete({ where: { id: zone.id } });
  });

  test('should delete a contact when another of the same type remains', async ({ authenticatedPage, db, seedData }) => {
    const page = authenticatedPage;
    const zoneName = `e2e-zone-contact-del-${Date.now()}`;
    const keepName = `e2e-keep-contact-${Date.now()}`;
    const removeName = `e2e-remove-contact-${Date.now()}`;

    const zone = await seedZone(db.prisma, seedData.organization.id, zoneName, [
      { name: keepName, contactType: 'Main', isShippingContact: true },
      { name: removeName, contactType: 'Main', isShippingContact: false },
    ]);
    const target = zone.contacts.find((contact) => contact.name === removeName);
    expect(target).toBeDefined();

    await page.goto(`/dcim/zones/${zone.id}/contacts/${target!.id}/delete`);
    await expect(page.getByRole('heading', { name: `Delete Contact: ${removeName}` })).toBeVisible();

    await page.getByRole('button', { name: 'Delete Contact' }).click();
    await page.waitForURL(new RegExp(`/dcim/zones/${zone.id}$`));

    // Soft delete: row remains with deletedAt set; the sibling stays active
    const deleted = await db.prisma.contact.findUnique({ where: { id: target!.id } });
    expect(deleted).not.toBeNull();
    expect(deleted!.deletedAt).not.toBeNull();

    const kept = await db.prisma.contact.findFirst({
      where: { zoneId: zone.id, name: keepName },
    });
    expect(kept).not.toBeNull();
    expect(kept!.deletedAt).toBeNull();

    await db.prisma.zone.delete({ where: { id: zone.id } });
  });

  test('should refuse to delete the last contact of a type', async ({ authenticatedPage, db, seedData }) => {
    const page = authenticatedPage;
    const zoneName = `e2e-zone-last-contact-${Date.now()}`;
    const contactName = `e2e-only-contact-${Date.now()}`;

    const zone = await seedZone(db.prisma, seedData.organization.id, zoneName, [
      { name: contactName, contactType: 'Main', isShippingContact: true },
    ]);
    const contact = zone.contacts[0];
    expect(contact).toBeDefined();

    await page.goto(`/dcim/zones/${zone.id}/contacts/${contact!.id}/delete`);
    await expect(page.getByRole('heading', { name: `Delete Contact: ${contactName}` })).toBeVisible();

    await page.getByRole('button', { name: 'Delete Contact' }).click();

    await expect(page.getByText('Cannot delete the last Main contact', { exact: true })).toBeVisible();

    // Contact is still active in the DB
    const stillActive = await db.prisma.contact.findUnique({ where: { id: contact!.id } });
    expect(stillActive).not.toBeNull();
    expect(stillActive!.deletedAt).toBeNull();

    await db.prisma.zone.delete({ where: { id: zone.id } });
  });

  test('should hide a soft-deleted zone from the list', async ({ authenticatedPage, db, seedData }) => {
    const page = authenticatedPage;
    const zoneName = `e2e-zone-gone-${Date.now()}`;

    const zone = await seedZone(db.prisma, seedData.organization.id, zoneName, [
      { name: 'Gone Contact', contactType: 'Main', isShippingContact: true },
    ]);

    await page.goto('/dcim/zones');
    await page.getByLabel('Search zones').fill(zoneName);
    await page.waitForURL((url) => url.searchParams.get('search') === zoneName);
    await expect(page.getByRole('link', { name: zoneName })).toBeVisible();

    await db.prisma.zone.update({
      where: { id: zone.id },
      data: { deletedAt: new Date() },
    });

    await page.reload();
    await expect(page.getByText('No zones found')).toBeVisible();
    await expect(page.getByRole('link', { name: zoneName })).not.toBeVisible();

    await db.prisma.zone.delete({ where: { id: zone.id } });
  });
});
