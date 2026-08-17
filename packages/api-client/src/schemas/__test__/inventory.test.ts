import { InventoryReservationInvitesSchema } from '../inventory';

describe('InventoryReservationInvitesSchema.inviteeOrganization', () => {
  const INTERNAL_ORG_FIELDS = ['tenantType', 'metadata', 'deletedAt', 'auth0OrganizationId', 'email', 'country'];

  it('keeps only id/name on the invitee organization and strips internal fields', () => {
    const parsed = InventoryReservationInvitesSchema.parse({
      id: 'inv-1',
      inviteeEmail: 'buyer@example.com',
      inviterEmail: 'supplier@example.com',
      inviteeOrganization: {
        id: 'org-1',
        name: 'Acme',
        tenantType: 'DemandCustomer',
        metadata: '{"x":1}',
        deletedAt: new Date(),
        auth0OrganizationId: 'auth0|1',
        email: 'org@example.com',
        country: 'US',
        logo: 'https://example.com/logo.png',
      },
      price: 100,
      billingFrequency: 'MONTHLY',
      dateCreated: '2026-01-01T00:00:00.000Z',
      dateExpires: '2026-02-01T00:00:00.000Z',
    });

    expect(parsed.inviteeOrganization).toEqual({ id: 'org-1', name: 'Acme' });
    for (const field of INTERNAL_ORG_FIELDS) {
      expect(parsed.inviteeOrganization).not.toHaveProperty(field);
    }
  });
});
