import { z } from 'zod';
import { DhcpModeSchema, IpamRoleSchema } from './ipam';

export const E164PhoneSchema = z
  .string()
  .regex(/^\+[1-9]\d{1,14}$/, 'Phone must be in E.164 format (e.g., +12125551234)')
  .describe('Phone number in E.164 international format');

export const ZoneAddressSchema = z.object({
  id: z.string().describe('Unique identifier for the address'),
  formattedAddress: z.string().describe('Full display address from autocomplete'),
  addressLineOne: z.string().describe('Street address'),
  addressLineTwo: z.string().nullable().describe('Suite, unit, floor'),
  city: z.string().describe('City or locality'),
  stateOrProvince: z.string().nullable().describe('State, province, or region (null for countries without)'),
  postalCode: z.string().nullable().describe('Postal or ZIP code (null for countries without)'),
  country: z.string().nullable().describe('Country display name (null for manually entered addresses)'),
  countryCode: z.string().describe('ISO 3166-1 alpha-2 country code'),
  latitude: z.number().min(-90).max(90).nullable().describe('Geographic latitude (null when not geocoded)'),
  longitude: z.number().min(-180).max(180).nullable().describe('Geographic longitude (null when not geocoded)'),
  timezone: z.string().describe('IANA timezone identifier'),
});

export type ZoneAddress = z.infer<typeof ZoneAddressSchema>;

export const ZoneAddressPersistenceSchema = ZoneAddressSchema.extend({
  type: z.enum(['PRIMARY', 'SHIPPING']).describe('Address role for the zone'),
});

export type ZoneAddressPersistence = z.infer<typeof ZoneAddressPersistenceSchema>;

export function toZoneAddress({ type: _, ...address }: ZoneAddressPersistence): ZoneAddress {
  return address;
}

export const ZoneContactTypeSchema = z.enum(['Main', 'Technical']).describe('Role category of the contact');

export type ZoneContactType = z.infer<typeof ZoneContactTypeSchema>;

export const ZoneContactSchema = z.object({
  id: z.string().describe('Unique identifier for the contact'),
  name: z.string().describe('Full name of the contact'),
  title: z.string().describe('Job title or role of the contact'),
  email: z.string().describe('Email address for the contact'),
  phone: z.string().describe('Phone number in E.164 format'),
  contactType: ZoneContactTypeSchema.describe('Role category of the contact'),
  isShippingContact: z.boolean().describe('Whether this contact handles shipping logistics'),
  createdAt: z.coerce.date().describe('Timestamp when the contact was created'),
  updatedAt: z.coerce.date().describe('Timestamp when the contact was last updated'),
});

export type ZoneContact = z.infer<typeof ZoneContactSchema>;

export const ZoneBridgeSchema = z.object({
  id: z.string().describe('Device UUID of the bridge'),
  name: z.string().describe('Display name of the bridge device'),
  online: z
    .boolean()
    .describe('Whether the bridge is reporting live right now (recent Redis heartbeat); derived at read time'),
  is_leader: z.boolean().describe('Whether this bridge currently holds zone leadership'),
});

export type ZoneBridge = z.infer<typeof ZoneBridgeSchema>;

export const ZoneSchema = z.object({
  id: z.string().describe('Unique identifier for the zone'),
  name: z.string().describe('Display name of the zone'),
  organizationId: z.string().describe('ID of the organization that owns this zone'),
  primaryAddress: ZoneAddressSchema.nullable().describe('Primary physical address of the zone'),
  shippingAddress: ZoneAddressSchema.nullable().describe('Shipping address for the zone'),
  bridges: z.array(ZoneBridgeSchema).describe('Bridge devices assigned to this zone'),
  createdAt: z.coerce.date().describe('Timestamp when the zone was created'),
  updatedAt: z.coerce.date().describe('Timestamp when the zone was last updated'),
});

export type Zone = z.infer<typeof ZoneSchema>;

export const ZoneListItemSchema = z.object({
  id: z.string().describe('Unique identifier for the zone'),
  name: z.string().describe('Display name of the zone'),
  organizationId: z.string().describe('ID of the organization that owns this zone'),
  primaryAddress: ZoneAddressSchema.nullable().describe('Primary physical address of the zone'),
  contactCount: z.number().describe('Number of active contacts for this zone'),
  createdAt: z.coerce.date().describe('Timestamp when the zone was created'),
});

export type ZoneListItem = z.infer<typeof ZoneListItemSchema>;

const IANA_TIMEZONES = new Set(Intl.supportedValuesOf('timeZone'));
const regionDisplayNames = new Intl.DisplayNames(['en'], { type: 'region' });

export const AddressInputSchema = z.object({
  addressLineOne: z.string().min(1, 'Address is required').describe('Street address'),
  addressLineTwo: z.string().optional().describe('Suite, unit, floor'),
  city: z.string().min(1, 'City is required').describe('City or locality'),
  stateOrProvince: z.string().optional().describe('State, province, or region'),
  postalCode: z.string().optional().describe('Postal or ZIP code'),
  countryCode: z
    .string()
    .regex(/^[A-Z]{2}$/, 'Must be an uppercase ISO 3166-1 alpha-2 code')
    .refine((c) => regionDisplayNames.of(c) !== c, 'Unknown ISO 3166-1 country code')
    .describe('ISO 3166-1 alpha-2 country code'),
  latitude: z.number().min(-90).max(90).finite().describe('Geographic latitude'),
  longitude: z.number().min(-180).max(180).finite().describe('Geographic longitude'),
  timezone: z
    .string()
    .refine((tz) => IANA_TIMEZONES.has(tz), 'Must be a valid IANA timezone identifier')
    .describe('IANA timezone identifier'),
});

export type AddressInput = z.infer<typeof AddressInputSchema>;

export const ContactInputSchema = z.object({
  name: z.string().min(1, 'Name is required').describe('Full name of the contact'),
  title: z.string().min(1, 'Title is required').describe('Job title or role of the contact'),
  email: z.string().email('Invalid email address').describe('Email address for the contact'),
  phone: E164PhoneSchema.describe('Phone number in E.164 format'),
  contactType: ZoneContactTypeSchema.describe('Role category of the contact'),
  isShippingContact: z.boolean().default(false).describe('Whether this contact handles shipping logistics'),
});

export type ContactInput = z.infer<typeof ContactInputSchema>;

export const CreateZoneRequestSchema = z.object({
  name: z.string().min(1, 'Zone name is required').describe('Name for the new zone'),
  primaryAddress: AddressInputSchema.describe('Primary physical address of the zone'),
  shippingAddress: AddressInputSchema.optional().describe('Optional separate shipping address for the zone'),
  contacts: z
    .array(ContactInputSchema)
    .min(1, 'At least one contact is required')
    .describe('List of contacts associated with the zone'),
});

export type CreateZoneRequest = z.infer<typeof CreateZoneRequestSchema>;

export const ZoneRedisCredentialSchema = z.object({
  username: z.string().describe('Redis ACL username for this zone (brokkr-spoke-<zoneId>)'),
  password: z.string().describe('Redis ACL password — shown exactly once, never retrievable afterwards'),
});

export type ZoneRedisCredential = z.infer<typeof ZoneRedisCredentialSchema>;

export const CreateZoneResponseSchema = z.object({
  id: z.string().describe('Unique identifier of the newly created zone'),
  name: z.string().describe('Name of the newly created zone'),
  redisCredential: ZoneRedisCredentialSchema.optional().describe(
    'Per-zone Redis ACL credential; only present when the hub has Redis ACL management enabled',
  ),
});

export type CreateZoneResponse = z.infer<typeof CreateZoneResponseSchema>;

export const UpdateZoneNameSchema = z.object({
  name: z.string().min(1, 'Name is required').describe('Updated name for the zone'),
});

export type UpdateZoneName = z.infer<typeof UpdateZoneNameSchema>;

export const UpdatePrimaryAddressSchema = AddressInputSchema;

export type UpdatePrimaryAddress = z.infer<typeof UpdatePrimaryAddressSchema>;

export const UpdateShippingAddressSchema = AddressInputSchema;

export type UpdateShippingAddress = z.infer<typeof UpdateShippingAddressSchema>;

export const ZoneDhcpPrefixSummarySchema = z.object({
  prefixId: z.string().uuid().describe('Prefix UUID'),
  cidr: z.string().describe('CIDR notation of the prefix (e.g. 10.0.0.0/24)'),
  role: IpamRoleSchema.nullable().describe('IPAM role assigned to the prefix (e.g. PRIMARY, MANAGEMENT, NAT)'),
  dhcpMode: DhcpModeSchema.nullable().describe(
    'Current DHCP serving mode for the prefix, or null when DHCP is not configured',
  ),
  dhcpEligible: z
    .boolean()
    .describe(
      'Whether this prefix is eligible for DHCP serving (true when the prefix is IPv4, has a zone, and role is not NAT)',
    ),
});

export type ZoneDhcpPrefixSummary = z.infer<typeof ZoneDhcpPrefixSummarySchema>;

export const ZoneVrrpPrefixSummarySchema = z.object({
  prefixId: z.string().uuid().describe('Prefix UUID'),
  cidr: z.string().describe('CIDR notation of the prefix (e.g. 10.0.0.0/24)'),
  role: IpamRoleSchema.nullable().describe('IPAM role assigned to the prefix (e.g. PRIMARY, MANAGEMENT, NAT)'),
  vip: z
    .string()
    .nullable()
    .describe(
      'VIP address in host/mask form (e.g. 10.0.0.1/24), or null when VIP address resolution fails (e.g. soft-deleted IpAddress with stale vrrpVipId)',
    ),
  ifaceByBridge: z
    .record(z.string(), z.string())
    .describe('Map of bridge device name to the NIC name the VIP binds on (empty object when no bindings exist)'),
});

export type ZoneVrrpPrefixSummary = z.infer<typeof ZoneVrrpPrefixSummarySchema>;
