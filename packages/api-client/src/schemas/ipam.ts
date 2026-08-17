import { z } from 'zod';
import { BooleanQueryParamSchema } from './common';

export const PrefixStatusSchema = z.enum(['CONTAINER', 'ACTIVE', 'RESERVED', 'DEPRECATED']);
export type PrefixStatus = z.infer<typeof PrefixStatusSchema>;

export const IpamRoleSchema = z.enum(['ALLOCATION', 'COMMON', 'LOOPBACK', 'MANAGEMENT', 'NAT', 'PRIMARY']);
export type IpamRole = z.infer<typeof IpamRoleSchema>;

export const IpStatusSchema = z.enum(['ACTIVE', 'RESERVED', 'DEPRECATED', 'DHCP']);
export type IpStatus = z.infer<typeof IpStatusSchema>;

export const AssignedObjectTypeSchema = z.enum(['Interface', 'VirtualMachine', 'Device']);
export type AssignedObjectType = z.infer<typeof AssignedObjectTypeSchema>;

export const VlanStatusSchema = z.enum(['ACTIVE', 'RESERVED', 'DEPRECATED']);
export type VlanStatus = z.infer<typeof VlanStatusSchema>;

export const VLAN_VID_MIN = 2;
export const VLAN_VID_MAX = 4094;
export const VLAN_VID_RANGE_MESSAGE = `VID must be between ${VLAN_VID_MIN} and ${VLAN_VID_MAX}`;

export const IpRangeStatusSchema = z.enum(['ACTIVE', 'RESERVED', 'DEPRECATED']);
export type IpRangeStatus = z.infer<typeof IpRangeStatusSchema>;

export const VrfSchema = z.object({
  id: z.string().uuid().describe('Unique identifier of the VRF.'),
  name: z.string().describe('Human-readable name of the VRF (virtual routing & forwarding instance).'),
  rd: z.string().nullable().describe('Route distinguisher uniquely identifying this VRF, or null if unset.'),
  description: z.string().nullable().describe('Optional free-text description of the VRF.'),
  organizationId: z.string().uuid().describe('Identifier of the organization that owns this VRF.'),
  createdAt: z.coerce.date().describe('Timestamp when the VRF was created.'),
  updatedAt: z.coerce.date().describe('Timestamp when the VRF was last updated.'),
  deletedAt: z.coerce
    .date()
    .nullable()
    .describe('Timestamp when the VRF was archived (soft-deleted), or null if active.'),
});
export type Vrf = z.infer<typeof VrfSchema>;

// Netplan bond params: keys are interpolated verbatim into rendered YAML (a non-identifier key could inject
// stanzas) and values must be scalars — a nested object would serialize to "[object Object]" and mis-configure the bond.
export const BondParametersSchema = z
  .record(
    z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, 'bond parameter key must be a plain identifier'),
    z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
  )
  .refine((obj) => Object.keys(obj).length > 0, 'bond parameters must not be empty — use null to disable bonding');
export type BondParameters = z.infer<typeof BondParametersSchema>;

export const PrefixSchema = z.object({
  id: z.string().uuid().describe('Unique identifier of the prefix.'),
  prefix: z.string().describe('CIDR network block (e.g. "10.0.0.0/24").'),
  status: PrefixStatusSchema.describe(
    'Lifecycle status: CONTAINER (holds child prefixes), ACTIVE, RESERVED, or DEPRECATED.',
  ),
  isPool: z
    .boolean()
    .describe('When true, the prefix is an allocation pool whose host addresses can be assigned individually.'),
  role: IpamRoleSchema.nullable().describe(
    'Functional role of the prefix (e.g. MANAGEMENT for out-of-band device management), or null if unset. A zone-scoped MANAGEMENT prefix is what the commissioning network scan enumerates.',
  ),
  zoneId: z
    .string()
    .uuid()
    .nullable()
    .describe('Identifier of the zone (data center) this prefix belongs to, or null if not zone-scoped.'),
  organizationId: z.string().uuid().describe('Identifier of the organization that owns this prefix.'),
  vrfId: z
    .string()
    .uuid()
    .nullable()
    .describe('Identifier of the VRF this prefix belongs to, or null for the global table.'),
  parentId: z
    .string()
    .uuid()
    .nullable()
    .describe('Identifier of the parent prefix this is nested under, or null if top-level.'),
  vlanId: z.string().uuid().nullable().describe('Identifier of the VLAN associated with this prefix, or null if none.'),
  gatewayIpId: z
    .string()
    .uuid()
    .nullable()
    .describe("Identifier of the IP address designated as this prefix's gateway, or null if unset."),
  vrrpVipId: z
    .string()
    .uuid()
    .nullable()
    .describe(
      "Identifier of the IP address advertised to the zone's bridges as this prefix's VRRP floating IP, or null if unset. " +
        'The per-bridge NIC to bind it on is set separately (see the VRRP bindings endpoints).',
    ),
  prefixRoleId: z
    .string()
    .uuid()
    .nullable()
    .describe(
      'Identifier of the linked prefix/VLAN role (slug catalog) netplan uses for VLAN route metrics, or null if unset.',
    ),
  enableVlanTag: z
    .boolean()
    .describe('When true, rendered netplan VLAN-tags IPs in this prefix regardless of device role.'),
  bondParameters: BondParametersSchema.nullable().describe(
    'Netplan bond parameters emitted for bonded interfaces on this prefix, or null when not bonding.',
  ),
  createdAt: z.coerce.date().describe('Timestamp when the prefix was created.'),
  updatedAt: z.coerce.date().describe('Timestamp when the prefix was last updated.'),
  deletedAt: z.coerce
    .date()
    .nullable()
    .describe('Timestamp when the prefix was archived (soft-deleted), or null if active.'),
});
export type Prefix = z.infer<typeof PrefixSchema>;

export const VrrpBindingSchema = z.object({
  bridgeId: z
    .string()
    .uuid()
    .describe("Identifier of a bridge (a Device with role Bridge) in the prefix's zone that binds the VIP."),
  iface: z
    .string()
    .min(1)
    .max(15)
    .describe(
      'That bridge\'s own NIC name to bind the VIP on (e.g. "eth0.100"), max 15 chars (Linux IFNAMSIZ-1). Chosen from the bridge\'s interfaces.',
    ),
});
export type VrrpBinding = z.infer<typeof VrrpBindingSchema>;

export const VrrpBindingsSchema = z
  .array(VrrpBindingSchema)
  .superRefine((bindings, ctx) => {
    const seen = new Set<string>();
    bindings.forEach((binding, index) => {
      if (seen.has(binding.bridgeId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Duplicate bridge in VRRP bindings',
          path: [index, 'bridgeId'],
        });
      }
      seen.add(binding.bridgeId);
    });
  })
  .describe('Per-bridge NIC bindings for the VIP; each bridge may appear at most once.');

export const IpAddressSchema = z.object({
  id: z.string().uuid().describe('Unique identifier of the IP address record.'),
  address: z.string().describe('IP address, optionally in CIDR notation with a host mask (e.g. "10.0.0.5/24").'),
  status: IpStatusSchema.describe('Lifecycle status: ACTIVE, RESERVED, DEPRECATED, or DHCP (assigned dynamically).'),
  dnsName: z.string().nullable().describe('DNS hostname associated with this address, or null if none.'),
  organizationId: z.string().uuid().describe('Identifier of the organization that owns this IP address.'),
  vrfId: z
    .string()
    .uuid()
    .nullable()
    .describe('Identifier of the VRF this address belongs to, or null for the global table.'),
  assignedObjectType: AssignedObjectTypeSchema.nullable().describe(
    'Type of object this address is assigned to (Interface, VirtualMachine, or Device), or null if unassigned.',
  ),
  assignedObjectId: z
    .string()
    .nullable()
    .describe('Identifier of the object this address is assigned to, or null if unassigned.'),
  interfaceId: z
    .string()
    .uuid()
    .nullable()
    .describe('UUID of the interface this address is assigned to, or null if unassigned.'),
  createdAt: z.coerce.date().describe('Timestamp when the IP address record was created.'),
  updatedAt: z.coerce.date().describe('Timestamp when the IP address record was last updated.'),
  deletedAt: z.coerce
    .date()
    .nullable()
    .describe('Timestamp when the IP address was archived (soft-deleted), or null if active.'),
});
export type IpAddress = z.infer<typeof IpAddressSchema>;

export const VlanSchema = z.object({
  id: z.string().uuid().describe('Unique identifier of the VLAN.'),
  name: z.string().describe('Human-readable name of the VLAN (layer-2 segment).'),
  vid: z.number().int().describe(`802.1Q VLAN ID (${VLAN_VID_MIN}–${VLAN_VID_MAX}).`),
  description: z.string().nullable().describe('Optional free-text description of the VLAN.'),
  status: VlanStatusSchema.describe('Lifecycle status: ACTIVE, RESERVED, or DEPRECATED.'),
  organizationId: z.string().uuid().describe('Identifier of the organization that owns this VLAN.'),
  vrfId: z
    .string()
    .uuid()
    .nullable()
    .describe('Identifier of the VRF this VLAN belongs to, or null for the global table.'),
  createdAt: z.coerce.date().describe('Timestamp when the VLAN was created.'),
  updatedAt: z.coerce.date().describe('Timestamp when the VLAN was last updated.'),
  deletedAt: z.coerce
    .date()
    .nullable()
    .describe('Timestamp when the VLAN was archived (soft-deleted), or null if active.'),
});
export type Vlan = z.infer<typeof VlanSchema>;

export const IpRangeSchema = z.object({
  id: z.string().uuid().describe('Unique identifier of the IP range.'),
  start: z.string().describe('First IP address in the contiguous range (inclusive).'),
  end: z.string().describe('Last IP address in the contiguous range (inclusive).'),
  status: IpRangeStatusSchema.describe('Lifecycle status: ACTIVE, RESERVED, or DEPRECATED.'),
  purpose: z.string().nullable().describe('Optional free-text purpose of the range (e.g. "DHCP pool"), or null.'),
  organizationId: z.string().uuid().describe('Identifier of the organization that owns this IP range.'),
  prefixId: z.string().uuid().describe('Identifier of the parent prefix that contains this range.'),
  vrfId: z
    .string()
    .uuid()
    .nullable()
    .describe('Identifier of the VRF this range belongs to, or null for the global table.'),
  createdAt: z.coerce.date().describe('Timestamp when the IP range was created.'),
  updatedAt: z.coerce.date().describe('Timestamp when the IP range was last updated.'),
  deletedAt: z.coerce
    .date()
    .nullable()
    .describe('Timestamp when the IP range was archived (soft-deleted), or null if active.'),
});
export type IpRange = z.infer<typeof IpRangeSchema>;

export const CreateVrfRequestSchema = z.object({
  name: z.string().min(1).describe('Human-readable name for the new VRF.'),
  rd: z.string().trim().min(1).optional().describe('Optional route distinguisher uniquely identifying the VRF.'),
  description: z.string().trim().optional().describe('Optional free-text description of the VRF.'),
});
export type CreateVrfRequest = z.infer<typeof CreateVrfRequestSchema>;

export const UpdateVrfRequestSchema = z.object({
  name: z.string().min(1).optional().describe('New name for the VRF; omit to leave unchanged.'),
  rd: z
    .string()
    .trim()
    .min(1)
    .nullable()
    .optional()
    .describe('New route distinguisher, or null to clear it; omit to leave unchanged.'),
  description: z
    .string()
    .trim()
    .nullable()
    .optional()
    .describe('New description, or null to clear it; omit to leave unchanged.'),
});
export type UpdateVrfRequest = z.infer<typeof UpdateVrfRequestSchema>;

export const VrfListQuerySchema = z.object({
  search: z
    .string()
    .trim()
    .optional()
    .describe('Case-insensitive text filter matched against VRF name and route distinguisher.'),
  includeArchived: BooleanQueryParamSchema.optional().describe(
    'Include soft-deleted (archived) records when true. Defaults to excluding them.',
  ),
});
export type VrfListQuery = z.infer<typeof VrfListQuerySchema>;

export const CreatePrefixRequestSchema = z.object({
  prefix: z.string().trim().min(1).describe('CIDR network block to create (e.g. "10.0.0.0/24").'),
  status: PrefixStatusSchema.optional().describe('Lifecycle status; defaults to ACTIVE if omitted.'),
  isPool: z
    .boolean()
    .optional()
    .describe('When true, mark the prefix as an allocation pool whose host addresses can be assigned.'),
  role: IpamRoleSchema.nullable()
    .optional()
    .describe('Functional role to assign (e.g. MANAGEMENT for commissioning scans), or null for none.'),
  zoneId: z
    .string()
    .uuid()
    .nullable()
    .optional()
    .describe('Zone (data center) to scope the prefix to, or null if not zone-scoped.'),
  vrfId: z.string().uuid().nullable().optional().describe('VRF to assign the prefix to, or null for the global table.'),
  parentId: z
    .string()
    .uuid()
    .nullable()
    .optional()
    .describe('Parent prefix to nest this under, or null for top-level.'),
  prefixRoleId: z
    .string()
    .uuid()
    .nullable()
    .optional()
    .describe('Prefix/VLAN role (slug catalog) to link — netplan reads its slug for VLAN route metrics; or null.'),
  enableVlanTag: z
    .boolean()
    .optional()
    .describe('When true, rendered netplan VLAN-tags this prefix regardless of device role; defaults to false.'),
  bondParameters: BondParametersSchema.nullable()
    .optional()
    .describe('Netplan bond parameters to emit for bonded interfaces on this prefix, or null for no bonding.'),
});
export type CreatePrefixRequest = z.infer<typeof CreatePrefixRequestSchema>;

export const UpdatePrefixRequestSchema = z.object({
  status: PrefixStatusSchema.optional().describe('New lifecycle status; omit to leave unchanged.'),
  isPool: z.boolean().optional().describe('New allocation-pool flag; omit to leave unchanged.'),
  role: IpamRoleSchema.nullable()
    .optional()
    .describe('New functional role, or null to clear it; omit to leave unchanged.'),
  zoneId: z
    .string()
    .uuid()
    .nullable()
    .optional()
    .describe('New zone (data center) assignment, or null to clear it; omit to leave unchanged.'),
  vrfId: z
    .string()
    .uuid()
    .nullable()
    .optional()
    .describe('New VRF assignment, or null for the global table; omit to leave unchanged.'),
  parentId: z
    .string()
    .uuid()
    .nullable()
    .optional()
    .describe('New parent prefix, or null for top-level; omit to leave unchanged.'),
  vlanId: z
    .string()
    .uuid()
    .nullable()
    .optional()
    .describe('New VLAN association, or null to clear it; omit to leave unchanged.'),
  gatewayIpId: z
    .string()
    .uuid()
    .nullable()
    .optional()
    .describe('New gateway IP assignment, or null to clear it; omit to leave unchanged.'),
  prefixRoleId: z
    .string()
    .uuid()
    .nullable()
    .optional()
    .describe('New prefix/VLAN role link, or null to clear it; omit to leave unchanged.'),
  enableVlanTag: z.boolean().optional().describe('New forced-VLAN-tagging flag; omit to leave unchanged.'),
  bondParameters: BondParametersSchema.nullable()
    .optional()
    .describe('New netplan bond parameters, or null to clear bonding; omit to leave unchanged.'),
});
export type UpdatePrefixRequest = z.infer<typeof UpdatePrefixRequestSchema>;

export const PrefixListQuerySchema = z.object({
  search: z.string().trim().optional().describe('Case-insensitive text filter matched against the prefix CIDR.'),
  vrfId: z.string().uuid().optional().describe('Only return prefixes belonging to this VRF.'),
  status: PrefixStatusSchema.optional().describe('Only return prefixes with this lifecycle status.'),
  parentId: z.string().uuid().optional().describe('Only return prefixes nested directly under this parent prefix.'),
  vlanId: z.string().uuid().optional().describe('Only return prefixes associated with this VLAN.'),
  includeArchived: BooleanQueryParamSchema.optional().describe(
    'Include soft-deleted (archived) records when true. Defaults to excluding them.',
  ),
});
export type PrefixListQuery = z.infer<typeof PrefixListQuerySchema>;

export const CreateIpAddressRequestSchema = z.object({
  address: z.string().trim().min(1).describe('IP address to create, optionally in CIDR notation (e.g. "10.0.0.5/24").'),
  status: IpStatusSchema.optional().describe('Lifecycle status; defaults to ACTIVE if omitted.'),
  dnsName: z.string().trim().optional().describe('Optional DNS hostname to associate with the address.'),
  vrfId: z
    .string()
    .uuid()
    .nullable()
    .optional()
    .describe('VRF to assign the address to, or null for the global table.'),
  interfaceId: z
    .string()
    .uuid()
    .optional()
    .describe('Interface to assign this address to on creation; omit to leave the address unassigned.'),
});
export type CreateIpAddressRequest = z.infer<typeof CreateIpAddressRequestSchema>;

export const UpdateIpAddressRequestSchema = z.object({
  status: IpStatusSchema.optional().describe('New lifecycle status; omit to leave unchanged.'),
  dnsName: z
    .string()
    .trim()
    .nullable()
    .optional()
    .describe('New DNS hostname, or null to clear it; omit to leave unchanged.'),
  vrfId: z
    .string()
    .uuid()
    .nullable()
    .optional()
    .describe('New VRF assignment, or null for the global table; omit to leave unchanged.'),
  interfaceId: z
    .string()
    .uuid()
    .nullable()
    .optional()
    .describe('Interface to assign this address to, or null to unassign it; omit to leave unchanged.'),
});
export type UpdateIpAddressRequest = z.infer<typeof UpdateIpAddressRequestSchema>;

export const IpAddressListQuerySchema = z.object({
  search: z
    .string()
    .trim()
    .optional()
    .describe('Case-insensitive text filter matched against the address and DNS name.'),
  vrfId: z.string().uuid().optional().describe('Only return addresses belonging to this VRF.'),
  status: IpStatusSchema.optional().describe('Only return addresses with this lifecycle status.'),
  prefix: z.string().trim().optional().describe('Only return addresses that fall within this CIDR prefix.'),
  assignedObjectType: AssignedObjectTypeSchema.optional().describe(
    'Only return addresses assigned to objects of this type (Interface, VirtualMachine, or Device).',
  ),
  assignedObjectId: z
    .string()
    .optional()
    .describe('Only return addresses assigned to the object with this identifier.'),
  includeArchived: BooleanQueryParamSchema.optional().describe(
    'Include soft-deleted (archived) records when true. Defaults to excluding them.',
  ),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('Maximum number of addresses to return (1–100). When omitted, all matching addresses are returned.'),
});
export type IpAddressListQuery = z.infer<typeof IpAddressListQuerySchema>;

export const DetectPrefixOverlapRequestSchema = z.object({
  prefix: z.string().trim().min(1).describe('Candidate CIDR network block to test for overlap.'),
  vrfId: z
    .string()
    .uuid()
    .nullable()
    .optional()
    .describe('VRF scope for the overlap check, or null for the global table.'),
  excludePrefixId: z
    .string()
    .uuid()
    .optional()
    .describe('Prefix to exclude from the check, e.g. the prefix being edited.'),
});
export type DetectPrefixOverlapRequest = z.infer<typeof DetectPrefixOverlapRequestSchema>;

export const ValidatePrefixGatewayRequestSchema = z.object({
  prefixId: z.string().uuid().describe('Identifier of the prefix the gateway would be applied to.'),
  gatewayIpId: z.string().uuid().describe('Identifier of the candidate gateway IP address.'),
});
export type ValidatePrefixGatewayRequest = z.infer<typeof ValidatePrefixGatewayRequestSchema>;

export const ValidatePrefixGatewayResultSchema = z.object({
  valid: z.boolean().describe("True if the IP address is eligible to serve as the prefix's gateway."),
  reason: z.string().nullable().describe('Explanation when the gateway is not valid, or null when valid.'),
});
export type ValidatePrefixGatewayResult = z.infer<typeof ValidatePrefixGatewayResultSchema>;

export const PrefixOverlapResultSchema = z.object({
  hasOverlap: z.boolean().describe('True if the candidate prefix overlaps an existing prefix.'),
  conflictingPrefixId: z
    .string()
    .uuid()
    .nullable()
    .describe('Identifier of the overlapping prefix, or null if there is no overlap.'),
  conflictingPrefix: z.string().nullable().describe('CIDR of the overlapping prefix, or null if there is no overlap.'),
});
export type PrefixOverlapResult = z.infer<typeof PrefixOverlapResultSchema>;

export const PrefixUtilizationSchema = z.object({
  prefixId: z.string().uuid().describe('Identifier of the prefix these utilization figures describe.'),
  prefix: z.string().describe('CIDR network block of the prefix.'),
  family: z.number().int().describe('IP family of the prefix (4 for IPv4, 6 for IPv6).'),
  isPool: z.boolean().describe('Whether the prefix is an allocation pool.'),
  assignedIps: z.number().int().describe('Count of host addresses currently assigned within the prefix.'),
  poolCapacity: z.number().int().describe('Total number of host addresses the prefix can hold.'),
  availableIps: z.number().int().describe('Count of host addresses still available for assignment.'),
  utilizationPercent: z.number().describe("Percentage of the prefix's capacity that is assigned (0–100)."),
});
export type PrefixUtilization = z.infer<typeof PrefixUtilizationSchema>;

export const AllocateNextPrefixRequestSchema = z.object({
  targetMask: z.number().int().min(0).max(128).describe('Desired CIDR mask length for the new child prefix (e.g. 24).'),
  status: PrefixStatusSchema.optional().describe(
    'Lifecycle status for the allocated prefix; defaults to ACTIVE if omitted.',
  ),
  isPool: z.boolean().optional().describe('When true, mark the allocated prefix as an allocation pool.'),
});
export type AllocateNextPrefixRequest = z.infer<typeof AllocateNextPrefixRequestSchema>;

export const VlanListQuerySchema = z.object({
  search: z.string().trim().optional().describe('Case-insensitive text filter matched against VLAN name and VLAN ID.'),
  vrfId: z.string().uuid().optional().describe('Only return VLANs belonging to this VRF.'),
  status: VlanStatusSchema.optional().describe('Only return VLANs with this lifecycle status.'),
  includeArchived: BooleanQueryParamSchema.optional().describe(
    'Include soft-deleted (archived) records when true. Defaults to excluding them.',
  ),
});
export type VlanListQuery = z.infer<typeof VlanListQuerySchema>;

export const CreateVlanRequestSchema = z.object({
  name: z.string().trim().min(1).describe('Human-readable name for the new VLAN.'),
  vid: z
    .number()
    .int()
    .min(VLAN_VID_MIN)
    .max(VLAN_VID_MAX)
    .describe(`802.1Q VLAN ID (${VLAN_VID_MIN}–${VLAN_VID_MAX}).`),
  description: z.string().trim().optional().describe('Optional free-text description of the VLAN.'),
  status: VlanStatusSchema.optional().describe('Lifecycle status; defaults to ACTIVE if omitted.'),
  vrfId: z.string().uuid().nullable().optional().describe('VRF to assign the VLAN to, or null for the global table.'),
});
export type CreateVlanRequest = z.infer<typeof CreateVlanRequestSchema>;

export const UpdateVlanRequestSchema = z.object({
  name: z.string().trim().min(1).optional().describe('New name for the VLAN; omit to leave unchanged.'),
  vid: z
    .number()
    .int()
    .min(VLAN_VID_MIN)
    .max(VLAN_VID_MAX)
    .optional()
    .describe(`New 802.1Q VLAN ID (${VLAN_VID_MIN}–${VLAN_VID_MAX}); omit to leave unchanged.`),
  description: z
    .string()
    .trim()
    .nullable()
    .optional()
    .describe('New description, or null to clear it; omit to leave unchanged.'),
  status: VlanStatusSchema.optional().describe('New lifecycle status; omit to leave unchanged.'),
  vrfId: z
    .string()
    .uuid()
    .nullable()
    .optional()
    .describe('New VRF assignment, or null for the global table; omit to leave unchanged.'),
});
export type UpdateVlanRequest = z.infer<typeof UpdateVlanRequestSchema>;

export const IpRangeListQuerySchema = z.object({
  prefixId: z.string().uuid().optional().describe('Only return ranges contained within this parent prefix.'),
  vrfId: z.string().uuid().optional().describe('Only return ranges belonging to this VRF.'),
  status: IpRangeStatusSchema.optional().describe('Only return ranges with this lifecycle status.'),
  includeArchived: BooleanQueryParamSchema.optional().describe(
    'Include soft-deleted (archived) records when true. Defaults to excluding them.',
  ),
});
export type IpRangeListQuery = z.infer<typeof IpRangeListQuerySchema>;

export const CreateIpRangeRequestSchema = z.object({
  prefixId: z.string().uuid().describe('Identifier of the parent prefix that will contain the range.'),
  start: z.string().trim().min(1).describe('First IP address in the range (inclusive).'),
  end: z.string().trim().min(1).describe('Last IP address in the range (inclusive).'),
  status: IpRangeStatusSchema.optional().describe('Lifecycle status; defaults to ACTIVE if omitted.'),
  purpose: z.string().trim().optional().describe('Optional free-text purpose for the range (e.g. "DHCP pool").'),
  vrfId: z.string().uuid().nullable().optional().describe('VRF to assign the range to, or null for the global table.'),
});
export type CreateIpRangeRequest = z.infer<typeof CreateIpRangeRequestSchema>;

export const UpdateIpRangeRequestSchema = z.object({
  start: z.string().trim().min(1).optional().describe('New first IP address in the range; omit to leave unchanged.'),
  end: z.string().trim().min(1).optional().describe('New last IP address in the range; omit to leave unchanged.'),
  status: IpRangeStatusSchema.optional().describe('New lifecycle status; omit to leave unchanged.'),
  purpose: z
    .string()
    .trim()
    .nullable()
    .optional()
    .describe('New purpose, or null to clear it; omit to leave unchanged.'),
  vrfId: z
    .string()
    .uuid()
    .nullable()
    .optional()
    .describe('New VRF assignment, or null for the global table; omit to leave unchanged.'),
});
export type UpdateIpRangeRequest = z.infer<typeof UpdateIpRangeRequestSchema>;

export const DetectIpRangeOverlapRequestSchema = z.object({
  prefixId: z.string().uuid().describe('Identifier of the parent prefix to check for overlapping ranges within.'),
  start: z.string().trim().min(1).describe('First IP address of the candidate range (inclusive).'),
  end: z.string().trim().min(1).describe('Last IP address of the candidate range (inclusive).'),
  vrfId: z
    .string()
    .uuid()
    .nullable()
    .optional()
    .describe('VRF scope for the overlap check, or null for the global table.'),
  excludeRangeId: z
    .string()
    .uuid()
    .optional()
    .describe('Range to exclude from the check, e.g. the range being edited.'),
});
export type DetectIpRangeOverlapRequest = z.infer<typeof DetectIpRangeOverlapRequestSchema>;

export const IpRangeOverlapResultSchema = z.object({
  hasOverlap: z.boolean().describe('True if the candidate range overlaps an existing range.'),
  conflictingRangeId: z
    .string()
    .uuid()
    .nullable()
    .describe('Identifier of the overlapping range, or null if there is no overlap.'),
  conflictingStart: z
    .string()
    .nullable()
    .describe('Start address of the overlapping range, or null if there is no overlap.'),
  conflictingEnd: z
    .string()
    .nullable()
    .describe('End address of the overlapping range, or null if there is no overlap.'),
});
export type IpRangeOverlapResult = z.infer<typeof IpRangeOverlapResultSchema>;

export const IpamChangelogEntrySchema = z.object({
  id: z.string().uuid().describe('Unique identifier of the change-log entry.'),
  tableName: z.string().describe('Name of the IPAM table whose record changed (e.g. "Prefix").'),
  pk: z.string().uuid().describe('Primary key of the record that changed.'),
  before: z.unknown().describe('Snapshot of the record before the change, or null for a create.'),
  after: z.unknown().describe('Snapshot of the record after the change, or null for a delete.'),
  diff: z.unknown().describe('Field-level diff between the before and after snapshots.'),
  createdAt: z.coerce.date().describe('Timestamp when the change was recorded.'),
});
export type IpamChangelogEntry = z.infer<typeof IpamChangelogEntrySchema>;

export const IpamChangelogQuerySchema = z.object({
  tableName: z
    .enum(['Vrf', 'Prefix', 'IpAddress', 'Vlan', 'IpRange'])
    .optional()
    .describe('Only return change-log entries for this IPAM table.'),
  pk: z.string().uuid().optional().describe('Only return change-log entries for the record with this primary key.'),
  limit: z.coerce.number().int().min(1).max(200).optional().describe('Maximum number of entries to return (1–200).'),
});
export type IpamChangelogQuery = z.infer<typeof IpamChangelogQuerySchema>;

// ── DHCP config schemas ────────────────────────────────────────────────

export const DhcpModeSchema = z
  .enum(['AUTHORITATIVE', 'PROXY', 'OFF'])
  .describe(
    'DHCP serving mode: AUTHORITATIVE (full lease server), PROXY (PXE/boot info only, no address leasing), or OFF (disabled).',
  );
export type DhcpMode = z.infer<typeof DhcpModeSchema>;

export const IpxeBuildTargetSchema = z
  .enum(['IPXE', 'SNP', 'SNPONLY'])
  .describe('iPXE boot firmware flavor: IPXE, SNP, or SNPONLY.');
export type IpxeBuildTarget = z.infer<typeof IpxeBuildTargetSchema>;

// Authoritative reserved/auto-managed code list; the bridge OPT_* constants
// (apps/bridge/src/dhcp/dhcp-options.ts) consume these but export no matching set — edit here only.
export const RESERVED_DHCP_OPTIONS: Readonly<Record<number, string>> = {
  1: 'subnet mask (auto-derived)',
  3: 'routers (set via gateway)',
  6: 'DNS servers (auto-derived by the bridge)',
  28: 'broadcast (auto-derived)',
  43: 'vendor-specific info (PXE-managed)',
  50: 'requested IP (client option)',
  51: 'lease time (set via dedicated field)',
  52: 'overload (wire encoder)',
  53: 'message type (server-managed)',
  54: 'server identifier (server-managed)',
  55: 'parameter request list (client option)',
  57: 'max message size (client option)',
  58: 'renewal time (derived from lease)',
  59: 'rebinding time (derived from lease)',
  60: 'vendor class identifier (PXE-managed)',
  66: 'TFTP server (auto-derived by the bridge)',
  67: 'bootfile (set via boot target)',
};

export const RESERVED_DHCP_OPTION_CODES: ReadonlySet<number> = new Set(Object.keys(RESERVED_DHCP_OPTIONS).map(Number));

const Ipv4Schema = z
  .string()
  .regex(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/, 'Must be a valid IPv4 address (e.g. 192.168.1.1)')
  .refine(
    (ip) =>
      ip.split('.').every((octet) => {
        const n = Number.parseInt(octet, 10);
        return n >= 0 && n <= 255 && String(n) === octet;
      }),
    'Each octet must be 0-255 with no leading zeros',
  );

export const DhcpRelayAgentIpSchema = Ipv4Schema.refine(
  (ip) => {
    const [first, second] = ip.split('.').map(Number);
    return (
      ip !== '0.0.0.0' &&
      first !== 127 &&
      !(first === 169 && second === 254) &&
      // >= 224 covers multicast (224/4) AND Class E reserved (240/4, incl. broadcast)
      !(first !== undefined && first >= 224)
    );
  },
  { message: 'The DHCP relay agent IP must be a routable unicast IPv4 address' },
);

export const DhcpOptionSchema = z.object({
  code: z
    .number()
    .int()
    .min(1)
    .max(254)
    .describe('DHCP option code (1-254). Reserved/auto-managed codes are rejected at the service layer.'),
  value: z
    .string()
    .min(1)
    // Not an exact wire bound — RFC1035_NAME (opt 119) can encode >255 bytes from <=255 chars; the
    // bridge checks the ENCODED byte length and skips oversize options (dhcp-atom-mapper).
    .max(255)
    .describe(
      'Option value in the DHCP_OPTIONS grammar: IPv4 addresses, colon-separated hex bytes (aa:bb), ' +
        'decimal integers with optional width suffix (42i, 255b), or a plain string.',
    ),
});
export type DhcpOption = z.infer<typeof DhcpOptionSchema>;

// Canonical 6-octet lowercase colon-hex MAC (e.g. "aa:bb:cc:dd:ee:ff") — shared by the DHCP proxy
// allowlist and the derived reservation MAC so the two can't drift.
const CANONICAL_MAC_REGEX = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;

export const PrefixDhcpConfigSchema = z.object({
  dhcpMode: DhcpModeSchema.nullable().describe(
    'DHCP serving mode for this prefix. AUTHORITATIVE serves full leases; PROXY serves PXE boot only; ' +
      'OFF disables DHCP. Null means DHCP is not configured.',
  ),
  dhcpLeaseTtlSeconds: z
    .number()
    .int()
    .min(120)
    // Capped at INT32 max: the DB column is Prisma Int (PostgreSQL INTEGER); a larger
    // value passes Zod but overflows on write. ~68 years is ample for a DHCP lease.
    .max(0x7fffffff)
    .nullable()
    .describe(
      'Lease duration in seconds (120 to 2147483647). Null uses the code default (600). ' +
        'Renewal (T1) and rebind (T2) timers derive from this at render time.',
    ),
  ipxeBuildTarget: IpxeBuildTargetSchema.describe(
    'PXE boot firmware flavor for this prefix. IPXE is the standard iPXE ROM; SNP and SNPONLY are ' +
      'UEFI SNP variants. Always set; new prefixes default to IPXE.',
  ),
  dhcpOptions: z
    .array(DhcpOptionSchema)
    // A DHCP packet's option space is finite; 32 keeps the rendered packet encodable.
    .max(32)
    // The wire packet carries a single TLV per code; the server rejects duplicates too.
    .refine((opts) => new Set(opts.map((o) => o.code)).size === opts.length, {
      message: 'Duplicate DHCP option codes are not allowed',
    })
    .describe(
      'Custom DHCP options beyond the auto-managed ones (routers, DNS, lease, TFTP). ' +
        'Each entry is a {code, value} pair. Reserved/auto-managed codes are rejected server-side.',
    ),
  dhcpProxyAllowedMacs: z
    .array(z.string().regex(CANONICAL_MAC_REGEX, 'must be a lowercase colon-hex MAC (e.g. "aa:bb:cc:dd:ee:ff")'))
    .max(1024)
    .refine((macs) => new Set(macs).size === macs.length, {
      message: 'Duplicate MAC addresses are not allowed',
    })
    // No default: a full-replace update that omits this field must fail validation (fail-closed),
    // consistent with the sibling dhcpOptions array — never silently clear stored MACs.
    .describe(
      'Operator-added client MACs allowed to PXE-boot while dhcpMode is PROXY, on top of this ' +
        "prefix's known devices (which are always allowed). Empty = only known devices boot. " +
        'Ignored for AUTHORITATIVE/OFF.',
    ),
  dhcpProxyPeerAuthoritative: z
    .boolean()
    .describe(
      'Declares that an external authoritative DHCP server owns this segment while dhcpMode is PROXY, ' +
        "silencing the bridge's no-lease-authority warning. Ignored for AUTHORITATIVE/OFF.",
    ),
  dhcpRelayAgentIp: DhcpRelayAgentIpSchema.nullable().describe(
    'IPv4 address of the DHCP relay agent for this prefix. Null means that the prefix does not use a relay agent.',
  ),
});
export type PrefixDhcpConfig = z.infer<typeof PrefixDhcpConfigSchema>;

// Intentional identity alias: update is a full replace (not a partial patch), so the write shape
// is identical to the read shape. Split them only if the update gains .partial() or new fields.
export const UpdatePrefixDhcpConfigSchema = PrefixDhcpConfigSchema;
export type UpdatePrefixDhcpConfig = z.infer<typeof UpdatePrefixDhcpConfigSchema>;

export const DhcpLeaseSchema = z.object({
  ip: Ipv4Schema.describe('Leased IPv4 address (the per-lease Redis key suffix).'),
  mac: z
    // Mirrors the bridge lease store's LEASE_MAC_RE (dhcp.config.ts) so a valid bridge-emitted
    // lease never fails hub validation; enforces the lowercase colon-hex the description promises.
    .string()
    .regex(/^[0-9a-f]{2}(:[0-9a-f]{2}){0,15}$/, 'must be lowercase colon-hex (e.g. "aa:bb:cc:dd:ee:ff")')
    .describe('Client hardware address, lowercase colon-hex.'),
  hostname: z
    // Mirror the bridge lease-record schema (lease-record.schema.ts): a single legal DNS label or
    // null — never an empty string — so the hub can't surface a lease the bridge would reject.
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'must be a single legal DNS label (lowercase, internal hyphens only)')
    .nullable()
    .describe('Hostname the client reported (DHCP option 12) as one DNS label, or null if none.'),
  expiresAt: z.number().int().min(0).describe('Absolute lease expiry as a Unix timestamp in seconds.'),
});
export type DhcpLease = z.infer<typeof DhcpLeaseSchema>;

// Read-only DHCP reservation derived from a device interface's IP within a prefix (same JOIN as the atom
// builder), plus deviceId/interfaceId for UI link-through. Not persisted or editable here.
export const DhcpReservationSchema = z.object({
  mac: z
    // Lowercase colon-hex, exactly 6 octets — matches the atom builder's CANONICAL_MAC_RE ({5} repeats)
    // and the bridge's reservation dedup, so a non-48-bit MAC is dropped before it reaches the wire.
    .string()
    .regex(CANONICAL_MAC_REGEX, 'must be a 6-octet lowercase colon-hex MAC (e.g. "aa:bb:cc:dd:ee:ff")')
    .describe('Interface hardware address the reservation is keyed on, lowercase colon-hex (6 octets).'),
  ip: Ipv4Schema.describe('Reserved IPv4 host address (the interface IP that becomes the DHCP reservation).'),
  hostname: z
    .string()
    // Display device name (link-to-manage), not a wire value — not DNS-label-validated. `.catch(null)` degrades
    // an over-long name to null rather than dropping the reservation; loose charset keeps legit names (spaces, uppercase).
    .max(255)
    .nullable()
    .catch(null)
    .describe('Device name offered as the reservation hostname (display only), or null when absent or over-long.'),
  ipxeBuildTarget: IpxeBuildTargetSchema.nullable().describe(
    'Per-device iPXE firmware override (Device.ipxeBuildTarget); null means inherit the prefix/system default.',
  ),
  deviceId: z.string().uuid().describe('Owning device UUID — used to link through to device management.'),
  interfaceId: z.string().uuid().describe('Interface UUID bearing the reserved IP — used for the link-to-manage.'),
});
export type DhcpReservation = z.infer<typeof DhcpReservationSchema>;

// Max DNS servers advertisable in DHCP option 6: the option value is length-prefixed to 255 bytes
// on the wire (RFC 2132), and each IPv4 address is 4 bytes → 255 / 4 = 63.
export const MAX_DHCP_DNS_SERVERS = 63;

// Read-only resolved serving addresses for a prefix (next-server + DNS), derived from the VRRP VIP or the
// bridge NIC IPs in the prefix. Computed on demand from IPAM data (not persisted) for the zone-DHCP UI.
export const PrefixDhcpServingSchema = z.object({
  nextServer: Ipv4Schema.nullable().describe(
    'Candidate IPv4 next-server (TFTP boot) derived from the VRRP VIP or the first bridge NIC in the prefix, or ' +
      'null if none could be derived. Advisory only: the bridge advertises a next-server on the wire only when PXE ' +
      'is configured (an iPXE build target or explicit next-server), so this address may be shown even when TFTP ' +
      'is not actually served.',
  ),
  dnsServers: z
    .array(Ipv4Schema)
    .max(MAX_DHCP_DNS_SERVERS)
    .describe(
      'Candidate IPv4 DNS servers derived from IPAM (the VRRP VIP, or the local bridge plus HA peers in the ' +
        'prefix), ordered deterministically by address. Advisory only: the bridge advertises itself as DNS only ' +
        'when no explicit DNS servers are configured for the prefix, so the on-wire set may differ.',
    ),
});
export type PrefixDhcpServing = z.infer<typeof PrefixDhcpServingSchema>;
