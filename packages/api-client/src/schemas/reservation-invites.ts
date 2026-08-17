import { z } from 'zod';

const BillingFrequencyValues = ['HOURLY', 'WEEKLY', 'MONTHLY'] as const;

export const BillingFrequencySchema = z.enum(BillingFrequencyValues).describe('How often billing occurs');

export const ReservationInviteListingSchema = z.object({
  id: z.string().describe('Brokkr Device UUID'),
  deviceId: z.string().uuid().describe('UUID of the associated device'),
  name: z.string().describe('Display name of the listing'),
  specs: z
    .object({
      gpu: z.object({ model: z.string().nullable().describe('GPU model name') }).describe('GPU specifications'),
      cpu: z.object({ cores: z.number().nullable().describe('Number of CPU cores') }).describe('CPU specifications'),
      memory: z.number().nullable().describe('Total memory in GB'),
    })
    .describe('Hardware specifications for the listing'),
});

export const ReservationInviteSchema = z.object({
  id: z.string().describe('Unique identifier for the reservation invite'),
  inviteeEmail: z.string().nullable().describe('Email address of the invited party'),
  inviterEmail: z.string().describe('Email address of the person who created the invite'),
  inviteeOrganizationId: z.string().nullable().describe('Organization ID of the invited party'),
  dateAccepted: z.coerce.date().nullable().describe('Date the invite was accepted'),
  dateCreated: z.coerce.date().describe('Date the invite was created'),
  dateDeleted: z.coerce.date().nullable().describe('Date the invite was deleted, if applicable'),
  dateUpdated: z.coerce.date().describe('Date the invite was last updated'),
  dateExpires: z.coerce.date().describe('Expiration date of the invite'),
  organizationId: z.string().describe('ID of the organization that created the invite'),
  reservationId: z.string().nullable().describe('ID of the resulting reservation, if accepted'),
  price: z.number().describe('Price charged per unit'),
  billingFrequency: BillingFrequencySchema.describe('How often billing occurs'),
  deviceIds: z.array(z.string()).describe('List of device IDs included in the invite'),
});

export const ReservationInviteForUserSchema = ReservationInviteSchema.extend({
  manualBilling: z.boolean().describe('Whether billing is handled manually'),
  isActive: z.boolean().describe('Whether the invite is currently active'),
  listing: ReservationInviteListingSchema.nullable().describe('Associated listing details'),
});

export const DeviceReservationInviteSchema = ReservationInviteSchema.extend({
  inviterEmail: z.string().nullable().describe('Email of the inviter; null when redacted (non-DC_SALES invites)'),
  dateUpdated: z.coerce.date().nullable().describe('Date the invite was last updated; null if never updated'),
  price: z.number().nullable().describe('Price charged per unit, if set'),
  manualBilling: z.boolean().describe('Whether billing is handled manually'),
  interruptibleNoticePeriod: z.number().nullable().describe('Notice period in hours for interruptible contracts'),
  notes: z.string().nullable().describe('Additional notes about the invite'),
  inviteeOrganizationName: z.string().nullable().optional().describe('Display name of the invited organization'),
  listing: ReservationInviteListingSchema.nullable().describe('Associated listing details'),
});

export type ReservationInvite = z.infer<typeof ReservationInviteSchema>;
export type ReservationInviteForUser = z.infer<typeof ReservationInviteForUserSchema>;
export type DeviceReservationInvite = z.infer<typeof DeviceReservationInviteSchema>;
export type ReservationInviteListing = z.infer<typeof ReservationInviteListingSchema>;
