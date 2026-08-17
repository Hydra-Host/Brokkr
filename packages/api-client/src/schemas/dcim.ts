export { CreateZoneRequestSchema, ZoneSchema, type CreateZoneRequest, type Zone } from './zones';

export { InterfaceSchema, type Interface } from './interface';

export { BridgeResponseSchema, BridgeTypeEnum, type BridgeResponse, type BridgeType } from './dcim-bridges';

export {
  CommissionServerRequestSchema as CommissionDcimDeviceRequestSchema,
  CommissionServerRequestSchema,
  CreateReservationInviteRequestSchema as CreateDcimReservationInviteRequestSchema,
  CreateReservationInviteRequestSchema,
  ServerSchema as DcimDeviceSchema,
  ServerUpdateResponseSchema as DcimDeviceUpdateResponseSchema,
  ServersQuerySchema as DcimDevicesQuerySchema,
  ReservationBaremetalInviteSchema as DcimReservationBaremetalInviteSchema,
  EditReservationInviteRequestSchema as EditDcimReservationInviteRequestSchema,
  EditReservationInviteRequestSchema,
  ProvisionServerRequestSchema as ProvisionDcimDeviceRequestSchema,
  ProvisionServerRequestSchema,
  ReservationBaremetalInviteSchema,
  ServerSchema,
  ServerUpdateResponseSchema,
  ServersQuerySchema,
  UpdateServerInfoRequestSchema as UpdateDcimDeviceInfoRequestSchema,
  UpdateListingRequestSchema as UpdateDcimListingRequestSchema,
  UpdateNicknameRequestSchema as UpdateDcimNicknameRequestSchema,
  UpdateListingRequestSchema,
  UpdateNicknameRequestSchema,
  UpdateServerInfoRequestSchema,
  type CommissionServerRequest as CommissionDcimDeviceRequest,
  type CommissionServerRequest,
  type CreateReservationInviteRequest as CreateDcimReservationInviteRequest,
  type CreateReservationInviteRequest,
  type Server as DcimDevice,
  type ServerUpdateResponse as DcimDeviceUpdateResponse,
  type ServersQuery as DcimDevicesQuery,
  type ReservationBaremetalInvite as DcimReservationBaremetalInvite,
  type EditReservationInviteRequest as EditDcimReservationInviteRequest,
  type EditReservationInviteRequest,
  type ProvisionServerRequest as ProvisionDcimDeviceRequest,
  type ProvisionServerRequest,
  type ReservationBaremetalInvite,
  type Server,
  type ServerUpdateResponse,
  type ServersQuery,
  type UpdateServerInfoRequest as UpdateDcimDeviceInfoRequest,
  type UpdateListingRequest as UpdateDcimListingRequest,
  type UpdateNicknameRequest as UpdateDcimNicknameRequest,
  type UpdateListingRequest,
  type UpdateNicknameRequest,
  type UpdateServerInfoRequest,
} from './baremetal';

import { z } from 'zod';
import { BooleanQueryParamSchema } from './common';
import { IpStatusSchema } from './ipam';
import { PaginationQuerySchema, createPaginatedResponseSchema } from './pagination';

export const DcimInterfaceTypeSchema = z.enum([
  'ETHERNET_1G',
  'ETHERNET_10G',
  'ETHERNET_25G',
  'ETHERNET_40G',
  'ETHERNET_50G',
  'ETHERNET_100G',
  'ETHERNET_200G',
  'ETHERNET_400G',
  'ETHERNET_800G',
  'INFINIBAND_FDR',
  'INFINIBAND_EDR',
  'INFINIBAND_HDR',
  'INFINIBAND_NDR',
  'INFINIBAND_XDR',
  'IPMI_BMC',
  'BOND',
  'VIRTUAL',
]);
export type DcimInterfaceType = z.infer<typeof DcimInterfaceTypeSchema>;

export const DcimInterfaceLinkTypeSchema = z.enum(['INFINIBAND', 'ETHERNET']);
export type DcimInterfaceLinkType = z.infer<typeof DcimInterfaceLinkTypeSchema>;

export const DcimInterfaceModeSchema = z.enum(['ACCESS', 'TAGGED']);
export type DcimInterfaceMode = z.infer<typeof DcimInterfaceModeSchema>;

export const DcimRackStatusSchema = z.enum(['ACTIVE', 'PLANNED', 'RESERVED', 'DEPRECATED']);
export type DcimRackStatus = z.infer<typeof DcimRackStatusSchema>;

export const DcimRackRoleKindSchema = z.enum(['COMPUTE', 'NETWORK', 'STORAGE', 'MIXED', 'POWER']);
export type DcimRackRoleKind = z.infer<typeof DcimRackRoleKindSchema>;

export const DcimCableTypeSchema = z.enum([
  'CAT5E',
  'CAT6',
  'CAT6A',
  'MMF_OM3',
  'MMF_OM4',
  'SMF_OS1',
  'SMF_OS2',
  'POWER',
  'SERIAL',
  'USB',
  'COAX',
  'DAC',
  'AOC',
  'OTHER',
]);
export type DcimCableType = z.infer<typeof DcimCableTypeSchema>;

export const DcimCableStatusSchema = z.enum(['CONNECTED', 'PLANNED', 'DECOMMISSIONING']);
export type DcimCableStatus = z.infer<typeof DcimCableStatusSchema>;

export const DcimCableLengthUnitSchema = z.enum(['METERS', 'CENTIMETERS', 'FEET', 'INCHES']);
export type DcimCableLengthUnit = z.infer<typeof DcimCableLengthUnitSchema>;

export const DcimCableTerminationTypeSchema = z.enum([
  'INTERFACE',
  'CONSOLE_PORT',
  'CONSOLE_SERVER_PORT',
  'POWER_PORT',
  'POWER_OUTLET',
  'FRONT_PORT',
  'REAR_PORT',
]);
export type DcimCableTerminationType = z.infer<typeof DcimCableTerminationTypeSchema>;

export const DcimCableTerminationInputSchema = z.object({
  type: DcimCableTerminationTypeSchema.describe('Kind of port this cable end connects to'),
  id: z.string().uuid().describe('UUID of the port this cable end connects to'),
});
export type DcimCableTerminationInput = z.infer<typeof DcimCableTerminationInputSchema>;

export const DcimConsolePortTypeSchema = z.enum(['DE9', 'RJ45', 'USB_A', 'USB_C', 'USB_MINI', 'USB_MICRO', 'OTHER']);
export type DcimConsolePortType = z.infer<typeof DcimConsolePortTypeSchema>;

export const DcimPowerPortTypeSchema = z.enum(['IEC_C14', 'IEC_C20', 'NEMA_515P', 'NEMA_L630P', 'OTHER']);
export type DcimPowerPortType = z.infer<typeof DcimPowerPortTypeSchema>;

export const DcimPowerOutletTypeSchema = z.enum(['IEC_C13', 'IEC_C19', 'NEMA_515R', 'NEMA_L630R', 'OTHER']);
export type DcimPowerOutletType = z.infer<typeof DcimPowerOutletTypeSchema>;

export const DcimFeedLegPhaseSchema = z.enum(['A', 'B', 'C']);
export type DcimFeedLegPhase = z.infer<typeof DcimFeedLegPhaseSchema>;

export const DcimPortTypeSchema = z.enum(['RJ45', 'FC', 'LC', 'SC', 'ST', 'MPO', 'CS', 'SN', 'OTHER']);
export type DcimPortType = z.infer<typeof DcimPortTypeSchema>;

// Sibling of `InterfaceIpAddressSchema` in ./interface, which carries `prefix` (zone containment)
// instead of `status` (IPAM lifecycle) — the two endpoints expose different facets; don't merge.
export const DcimInterfaceIpSchema = z.object({
  id: z.string().uuid().describe('IpAddress UUID (used to unassign the address).'),
  address: z.string().describe('IP address, optionally in CIDR notation (e.g. "10.0.0.5/24").'),
  status: IpStatusSchema.describe('Lifecycle status of the assigned address.'),
});
export type DcimInterfaceIp = z.infer<typeof DcimInterfaceIpSchema>;

export const DcimInterfaceSchema = z.object({
  id: z.string().uuid().describe('Interface UUID'),
  name: z.string().describe('Interface name (e.g. eth0, bond0)'),
  type: DcimInterfaceTypeSchema.nullable().describe('Interface type (Ethernet speed, InfiniBand, etc.)'),
  enabled: z.boolean().describe('Whether the interface is enabled'),
  mtu: z.number().int().nullable().describe('Maximum transmission unit'),
  macAddress: z.string().nullable().describe('MAC address'),
  speed: z.number().int().nullable().describe('Link speed in Kbps'),
  mgmtOnly: z.boolean().describe('Whether this is a management-only interface'),
  markConnected: z
    .boolean()
    .describe('Whether the interface is treated as connected even without a live-detected link.'),
  mode: DcimInterfaceModeSchema.nullable().describe('VLAN mode (ACCESS or TAGGED)'),
  description: z.string().nullable().describe('Interface description'),
  linkType: DcimInterfaceLinkTypeSchema.nullable().describe('Link type (Ethernet or InfiniBand)'),
  guid: z.string().nullable().describe('InfiniBand GUID'),
  portState: z.string().nullable().describe('InfiniBand port state'),
  maxSpeedGbps: z.number().int().nullable().describe('Maximum speed in Gbps'),
  pciDeviceId: z.string().nullable().describe('PCI device ID'),
  lldpNeighborName: z.string().nullable().describe('LLDP neighbor system name'),
  lldpNeighborPort: z.string().nullable().describe('LLDP neighbor port identifier'),
  lldpNeighborDescr: z.string().nullable().describe('LLDP neighbor description'),
  lldpNeighborMgmtIp: z.string().nullable().describe('LLDP neighbor management IP'),
  deviceId: z.string().uuid().describe('Parent Brokkr device UUID'),
  lagId: z.string().uuid().nullable().describe('LAG/bond parent interface UUID'),
  parentId: z.string().uuid().nullable().describe('Parent interface UUID (sub-interface)'),
  untaggedVlanId: z.string().uuid().nullable().describe('Untagged VLAN UUID'),
  ipAddresses: z
    .array(DcimInterfaceIpSchema)
    .optional()
    .describe('IP addresses assigned to this interface. Only populated on the device-scoped interface read.'),
  createdAt: z.coerce.date().describe('Creation timestamp'),
  updatedAt: z.coerce.date().describe('Last update timestamp'),
});
// The base interface carries no IPs (the paginated list never returns them); the device-scoped read
// adds them via DeviceInterfaceWithIpsSchema below.
export type DcimInterface = z.infer<typeof DcimInterfaceSchema>;

// Single source of truth — the server guard (interface.record.ts) and the web form validate MACs with
// this. Matches WELL-FORMED MACs only (rejects ''); the "empty = no MAC" passthrough is macAddressSchema's.
export const MAC_ADDRESS_REGEX = /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$|^(?:[0-9a-f]{2}-){5}[0-9a-f]{2}$/i;
// 1–15 chars (Linux IFNAMSIZ-1). Single source of truth — the server guard (interface.record.ts)
// imports this, so the contract rejects exactly the names the server would.
export const INTERFACE_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9._@:-]{0,14}$/;
// Exported alongside the regex so the web form surfaces the same rejection text the contract uses —
// a single source of truth for the name-format message across client and contract.
export const INTERFACE_NAME_MESSAGE =
  'Name must be 1–15 chars: start with a letter/digit, then letters, digits, or ._@:-';
const macAddressSchema = z
  .string()
  .trim()
  .refine((v) => v === '' || MAC_ADDRESS_REGEX.test(v), 'MAC must be six hex octets separated by ":" or "-"');

export const CreateDcimInterfaceRequestSchema = z.object({
  name: z.string().regex(INTERFACE_NAME_REGEX, INTERFACE_NAME_MESSAGE).describe('Interface name'),
  type: DcimInterfaceTypeSchema.optional().describe('Interface type'),
  enabled: z.boolean().optional().describe('Whether the interface is enabled'),
  mtu: z.number().int().optional().describe('Maximum transmission unit'),
  macAddress: macAddressSchema.optional().describe('MAC address'),
  speed: z.number().int().optional().describe('Link speed in Kbps'),
  mgmtOnly: z.boolean().optional().describe('Whether this is management-only'),
  markConnected: z.boolean().optional().describe('Whether the interface is treated as connected without a live link'),
  mode: DcimInterfaceModeSchema.optional().describe('VLAN mode'),
  description: z.string().trim().optional().describe('Interface description'),
  linkType: DcimInterfaceLinkTypeSchema.optional().describe('Link type'),
  guid: z.string().optional().describe('InfiniBand GUID'),
  portState: z.string().optional().describe('InfiniBand port state'),
  maxSpeedGbps: z.number().int().optional().describe('Maximum speed in Gbps'),
  pciDeviceId: z.string().optional().describe('PCI device ID'),
  lldpNeighborName: z.string().optional().describe('LLDP neighbor system name'),
  lldpNeighborPort: z.string().optional().describe('LLDP neighbor port identifier'),
  lldpNeighborDescr: z.string().optional().describe('LLDP neighbor description'),
  lldpNeighborMgmtIp: z.string().optional().describe('LLDP neighbor management IP'),
  deviceId: z.string().uuid().describe('Parent Brokkr device UUID'),
  lagId: z.string().uuid().nullable().optional().describe('LAG/bond parent interface UUID'),
  parentId: z.string().uuid().nullable().optional().describe('Parent interface UUID'),
  untaggedVlanId: z.string().uuid().nullable().optional().describe('Untagged VLAN UUID'),
});
export type CreateDcimInterfaceRequest = z.infer<typeof CreateDcimInterfaceRequestSchema>;

export const UpdateDcimInterfaceRequestSchema = z.object({
  name: z.string().regex(INTERFACE_NAME_REGEX, INTERFACE_NAME_MESSAGE).optional().describe('Interface name'),
  type: DcimInterfaceTypeSchema.nullable().optional().describe('Interface type'),
  enabled: z.boolean().optional().describe('Whether the interface is enabled'),
  mtu: z.number().int().nullable().optional().describe('Maximum transmission unit'),
  macAddress: macAddressSchema.nullable().optional().describe('MAC address'),
  speed: z.number().int().nullable().optional().describe('Link speed in Kbps'),
  mgmtOnly: z.boolean().optional().describe('Whether this is management-only'),
  markConnected: z.boolean().optional().describe('Whether the interface is treated as connected without a live link'),
  mode: DcimInterfaceModeSchema.nullable().optional().describe('VLAN mode'),
  description: z.string().trim().nullable().optional().describe('Interface description'),
  linkType: DcimInterfaceLinkTypeSchema.nullable().optional().describe('Link type'),
  guid: z.string().nullable().optional().describe('InfiniBand GUID'),
  portState: z.string().nullable().optional().describe('InfiniBand port state'),
  maxSpeedGbps: z.number().int().nullable().optional().describe('Maximum speed in Gbps'),
  pciDeviceId: z.string().nullable().optional().describe('PCI device ID'),
  lldpNeighborName: z.string().nullable().optional().describe('LLDP neighbor system name'),
  lldpNeighborPort: z.string().nullable().optional().describe('LLDP neighbor port identifier'),
  lldpNeighborDescr: z.string().nullable().optional().describe('LLDP neighbor description'),
  lldpNeighborMgmtIp: z.string().nullable().optional().describe('LLDP neighbor management IP'),
  lagId: z.string().uuid().nullable().optional().describe('LAG/bond parent interface UUID'),
  parentId: z.string().uuid().nullable().optional().describe('Parent interface UUID'),
  untaggedVlanId: z.string().uuid().nullable().optional().describe('Untagged VLAN UUID'),
});
export type UpdateDcimInterfaceRequest = z.infer<typeof UpdateDcimInterfaceRequestSchema>;

export const DcimInterfaceListQuerySchema = PaginationQuerySchema.extend({
  deviceId: z.string().uuid().optional().describe('Filter by device UUID'),
  type: DcimInterfaceTypeSchema.optional().describe('Filter by interface type'),
  enabled: BooleanQueryParamSchema.optional().describe('Filter by enabled state'),
  linkType: DcimInterfaceLinkTypeSchema.optional().describe('Filter by link type (ETHERNET / INFINIBAND)'),
});
export type DcimInterfaceListQuery = z.infer<typeof DcimInterfaceListQuerySchema>;

export const DcimInterfaceListResponseSchema = createPaginatedResponseSchema(DcimInterfaceSchema);
export type DcimInterfaceListResponse = z.infer<typeof DcimInterfaceListResponseSchema>;

// The device-scoped read always populates ipAddresses (InterfacePresenter.toResponseWithIps), so
// require it here rather than inheriting DcimInterfaceSchema's optional field.
export const DeviceInterfaceWithIpsSchema = DcimInterfaceSchema.extend({
  ipAddresses: z.array(DcimInterfaceIpSchema).describe('IP addresses assigned to this interface.'),
});
export type DeviceInterfaceWithIps = z.infer<typeof DeviceInterfaceWithIpsSchema>;

export const DeviceInterfacesResponseSchema = z.array(DeviceInterfaceWithIpsSchema);
export type DeviceInterfacesResponse = z.infer<typeof DeviceInterfacesResponseSchema>;

// A create within a bulk apply: same as CreateDcimInterfaceRequest but the parent
// device is taken from the path, so `deviceId` is omitted here.
export const BulkCreateDcimInterfaceSchema = CreateDcimInterfaceRequestSchema.omit({ deviceId: true });
export type BulkCreateDcimInterface = z.infer<typeof BulkCreateDcimInterfaceSchema>;

// An update within a bulk apply: the interface UUID plus the same optional fields
// as a single-row update.
export const BulkUpdateDcimInterfaceSchema = UpdateDcimInterfaceRequestSchema.extend({
  id: z.string().uuid().describe('UUID of the interface to update'),
});
export type BulkUpdateDcimInterface = z.infer<typeof BulkUpdateDcimInterfaceSchema>;

// Caps the whole batch (creates + updates + deletes), not each array independently — that would let
// one request carry 3× this many DB writes in a single long-lived transaction (lock-contention DoS).
export const MAX_BULK_INTERFACE_OPS = 128;

export const BulkUpdateDeviceInterfacesRequestSchema = z
  .object({
    // No per-array `.max` — the combined `.refine` below caps the total, which subsumes any single
    // array's length (an over-cap single array also over-caps the total).
    creates: z.array(BulkCreateDcimInterfaceSchema).default([]).describe('New interfaces to create on the device.'),
    updates: z
      .array(BulkUpdateDcimInterfaceSchema)
      .default([])
      .describe('Existing interfaces to update, keyed by UUID.'),
    deletes: z.array(z.string().uuid()).default([]).describe('UUIDs of interfaces to delete from the device.'),
  })
  .refine((v) => v.creates.length + v.updates.length + v.deletes.length <= MAX_BULK_INTERFACE_OPS, {
    message: `Total bulk interface operations must not exceed ${MAX_BULK_INTERFACE_OPS}`,
  })
  // The same interface can't be both updated and deleted in one apply — the server rejects it (a
  // P2025 mid-transaction crash otherwise), so pin the invariant in the contract too.
  .refine(
    (v) => {
      const deleteSet = new Set(v.deletes);
      return v.updates.every((u) => !deleteSet.has(u.id));
    },
    { message: 'An interface UUID cannot appear in both updates and deletes' },
  )
  // The server dedups `updates` into a Map keyed by id, so a duplicate would slip its rename past the
  // name-uniqueness pre-flight and collide mid-transaction (500 instead of a clean 400).
  .refine((v) => new Set(v.updates.map((u) => u.id)).size === v.updates.length, {
    message: 'An interface UUID cannot appear more than once in updates',
  });
export type BulkUpdateDeviceInterfacesRequest = z.infer<typeof BulkUpdateDeviceInterfacesRequestSchema>;

export const DcimRackSchema = z.object({
  id: z.string().uuid().describe('Rack UUID'),
  name: z.string().describe('Rack name'),
  status: DcimRackStatusSchema.describe('Rack status'),
  role: DcimRackRoleKindSchema.nullable().describe('Rack role'),
  heightU: z.number().int().describe('Rack height in rack units'),
  startingUnit: z.number().int().describe('First rack unit number'),
  description: z.string().nullable().describe('Rack description'),
  serial: z.string().nullable().describe('Rack serial number'),
  assetTag: z.string().nullable().describe('Asset tag'),
  zoneId: z.string().uuid().describe('Zone UUID'),
  organizationId: z.string().uuid().nullable().describe('Owning organization UUID'),
  createdAt: z.coerce.date().describe('Creation timestamp'),
  updatedAt: z.coerce.date().describe('Last update timestamp'),
});
export type DcimRack = z.infer<typeof DcimRackSchema>;

export const CreateDcimRackRequestSchema = z.object({
  name: z.string().min(1).describe('Rack name'),
  status: DcimRackStatusSchema.optional().describe('Rack status'),
  role: DcimRackRoleKindSchema.optional().describe('Rack role'),
  heightU: z.number().int().min(1).max(1000).optional().describe('Rack height in rack units'),
  startingUnit: z.number().int().min(1).max(1000).optional().describe('First rack unit number'),
  description: z.string().trim().optional().describe('Rack description'),
  serial: z.string().trim().optional().describe('Rack serial number'),
  assetTag: z.string().trim().optional().describe('Asset tag'),
  zoneId: z.string().uuid().describe('Zone UUID'),
});
export type CreateDcimRackRequest = z.infer<typeof CreateDcimRackRequestSchema>;

export const UpdateDcimRackRequestSchema = z.object({
  name: z.string().min(1).optional().describe('Rack name'),
  status: DcimRackStatusSchema.optional().describe('Rack status'),
  role: DcimRackRoleKindSchema.nullable().optional().describe('Rack role'),
  heightU: z.number().int().min(1).max(1000).optional().describe('Rack height in rack units'),
  startingUnit: z.number().int().min(1).max(1000).optional().describe('First rack unit number'),
  description: z.string().trim().nullable().optional().describe('Rack description'),
  serial: z.string().trim().nullable().optional().describe('Rack serial number'),
  assetTag: z.string().trim().nullable().optional().describe('Asset tag'),
});
export type UpdateDcimRackRequest = z.infer<typeof UpdateDcimRackRequestSchema>;

export const DcimRackListQuerySchema = PaginationQuerySchema.extend({
  zoneId: z.string().uuid().optional().describe('Filter by zone UUID'),
  status: DcimRackStatusSchema.optional().describe('Filter by rack status'),
  role: DcimRackRoleKindSchema.optional().describe('Filter by rack role'),
});
export type DcimRackListQuery = z.infer<typeof DcimRackListQuerySchema>;

export const DcimRackListResponseSchema = createPaginatedResponseSchema(DcimRackSchema);
export type DcimRackListResponse = z.infer<typeof DcimRackListResponseSchema>;

export const DcimCableSchema = z.object({
  id: z.string().uuid().describe('Cable UUID'),
  type: DcimCableTypeSchema.nullable().describe('Cable type'),
  status: DcimCableStatusSchema.describe('Cable status'),
  label: z.string().nullable().describe('Cable label'),
  color: z.string().nullable().describe('Cable color (hex code)'),
  length: z.number().nullable().describe('Cable length'),
  lengthUnit: DcimCableLengthUnitSchema.nullable().describe('Unit for cable length'),
  description: z.string().nullable().describe('Cable description'),
  createdAt: z.coerce.date().describe('Creation timestamp'),
  updatedAt: z.coerce.date().describe('Last update timestamp'),
});
export type DcimCable = z.infer<typeof DcimCableSchema>;

export const CreateDcimCableRequestSchema = z.object({
  type: DcimCableTypeSchema.optional().describe('Cable type'),
  status: DcimCableStatusSchema.optional().describe('Cable status'),
  label: z.string().trim().optional().describe('Cable label'),
  color: z.string().trim().optional().describe('Cable color (hex code)'),
  length: z.number().optional().describe('Cable length'),
  lengthUnit: DcimCableLengthUnitSchema.optional().describe('Unit for cable length'),
  description: z.string().trim().optional().describe('Cable description'),
  aTermination: DcimCableTerminationInputSchema.describe('The A-side port this cable connects to'),
  bTermination: DcimCableTerminationInputSchema.describe('The B-side port this cable connects to'),
});
export type CreateDcimCableRequest = z.infer<typeof CreateDcimCableRequestSchema>;

export const UpdateDcimCableRequestSchema = z.object({
  type: DcimCableTypeSchema.nullable().optional().describe('Cable type'),
  status: DcimCableStatusSchema.optional().describe('Cable status'),
  label: z.string().trim().nullable().optional().describe('Cable label'),
  color: z.string().trim().nullable().optional().describe('Cable color (hex code)'),
  length: z.number().nullable().optional().describe('Cable length'),
  lengthUnit: DcimCableLengthUnitSchema.nullable().optional().describe('Unit for cable length'),
  description: z.string().trim().nullable().optional().describe('Cable description'),
});
export type UpdateDcimCableRequest = z.infer<typeof UpdateDcimCableRequestSchema>;

export const DcimCableListQuerySchema = PaginationQuerySchema.extend({
  status: DcimCableStatusSchema.optional().describe('Filter by cable status'),
  type: DcimCableTypeSchema.optional().describe('Filter by cable type'),
});
export type DcimCableListQuery = z.infer<typeof DcimCableListQuerySchema>;

export const DcimCableListResponseSchema = createPaginatedResponseSchema(DcimCableSchema);
export type DcimCableListResponse = z.infer<typeof DcimCableListResponseSchema>;

export const DcimConsolePortSchema = z.object({
  id: z.string().uuid().describe('Console port UUID'),
  name: z.string().describe('Console port name'),
  type: DcimConsolePortTypeSchema.nullable().describe('Console port connector type'),
  speed: z.number().int().nullable().describe('Port speed in bps'),
  description: z.string().nullable().describe('Console port description'),
  deviceId: z.string().uuid().describe('Parent device UUID'),
  createdAt: z.coerce.date().describe('Creation timestamp'),
  updatedAt: z.coerce.date().describe('Last update timestamp'),
});
export type DcimConsolePort = z.infer<typeof DcimConsolePortSchema>;

export const CreateDcimConsolePortRequestSchema = z.object({
  name: z.string().min(1).describe('Console port name'),
  type: DcimConsolePortTypeSchema.optional().describe('Console port connector type'),
  speed: z.number().int().optional().describe('Port speed in bps'),
  description: z.string().trim().optional().describe('Console port description'),
  deviceId: z.string().uuid().describe('Parent device UUID'),
});
export type CreateDcimConsolePortRequest = z.infer<typeof CreateDcimConsolePortRequestSchema>;

export const UpdateDcimConsolePortRequestSchema = z.object({
  name: z.string().min(1).optional().describe('Console port name'),
  type: DcimConsolePortTypeSchema.nullable().optional().describe('Console port connector type'),
  speed: z.number().int().nullable().optional().describe('Port speed in bps'),
  description: z.string().trim().nullable().optional().describe('Console port description'),
});
export type UpdateDcimConsolePortRequest = z.infer<typeof UpdateDcimConsolePortRequestSchema>;

export const DcimConsolePortListQuerySchema = PaginationQuerySchema.extend({
  deviceId: z.string().uuid().optional().describe('Filter by device UUID'),
  type: DcimConsolePortTypeSchema.optional().describe('Filter by connector type'),
});
export type DcimConsolePortListQuery = z.infer<typeof DcimConsolePortListQuerySchema>;

export const DcimConsolePortListResponseSchema = createPaginatedResponseSchema(DcimConsolePortSchema);
export type DcimConsolePortListResponse = z.infer<typeof DcimConsolePortListResponseSchema>;

export const DcimConsoleServerPortSchema = z.object({
  id: z.string().uuid().describe('Console server port UUID'),
  name: z.string().describe('Console server port name'),
  type: DcimConsolePortTypeSchema.nullable().describe('Console server port connector type'),
  speed: z.number().int().nullable().describe('Port speed in bps'),
  description: z.string().nullable().describe('Console server port description'),
  deviceId: z.string().uuid().describe('Parent device UUID'),
  createdAt: z.coerce.date().describe('Creation timestamp'),
  updatedAt: z.coerce.date().describe('Last update timestamp'),
});
export type DcimConsoleServerPort = z.infer<typeof DcimConsoleServerPortSchema>;

export const CreateDcimConsoleServerPortRequestSchema = z.object({
  name: z.string().min(1).describe('Console server port name'),
  type: DcimConsolePortTypeSchema.optional().describe('Console server port connector type'),
  speed: z.number().int().optional().describe('Port speed in bps'),
  description: z.string().trim().optional().describe('Console server port description'),
  deviceId: z.string().uuid().describe('Parent device UUID'),
});
export type CreateDcimConsoleServerPortRequest = z.infer<typeof CreateDcimConsoleServerPortRequestSchema>;

export const UpdateDcimConsoleServerPortRequestSchema = z.object({
  name: z.string().min(1).optional().describe('Console server port name'),
  type: DcimConsolePortTypeSchema.nullable().optional().describe('Console server port connector type'),
  speed: z.number().int().nullable().optional().describe('Port speed in bps'),
  description: z.string().trim().nullable().optional().describe('Console server port description'),
});
export type UpdateDcimConsoleServerPortRequest = z.infer<typeof UpdateDcimConsoleServerPortRequestSchema>;

export const DcimConsoleServerPortListQuerySchema = PaginationQuerySchema.extend({
  deviceId: z.string().uuid().optional().describe('Filter by device UUID'),
  type: DcimConsolePortTypeSchema.optional().describe('Filter by connector type'),
});
export type DcimConsoleServerPortListQuery = z.infer<typeof DcimConsoleServerPortListQuerySchema>;

export const DcimConsoleServerPortListResponseSchema = createPaginatedResponseSchema(DcimConsoleServerPortSchema);
export type DcimConsoleServerPortListResponse = z.infer<typeof DcimConsoleServerPortListResponseSchema>;

export const DcimPowerPortSchema = z.object({
  id: z.string().uuid().describe('Power port UUID'),
  name: z.string().describe('Power port name'),
  type: DcimPowerPortTypeSchema.nullable().describe('Power port connector type'),
  maximumDraw: z.number().int().nullable().describe('Maximum power draw in watts'),
  allocatedDraw: z.number().int().nullable().describe('Allocated power draw in watts'),
  description: z.string().nullable().describe('Power port description'),
  deviceId: z.string().uuid().describe('Parent device UUID'),
  createdAt: z.coerce.date().describe('Creation timestamp'),
  updatedAt: z.coerce.date().describe('Last update timestamp'),
});
export type DcimPowerPort = z.infer<typeof DcimPowerPortSchema>;

export const CreateDcimPowerPortRequestSchema = z.object({
  name: z.string().min(1).describe('Power port name'),
  type: DcimPowerPortTypeSchema.optional().describe('Power port connector type'),
  maximumDraw: z.number().int().optional().describe('Maximum power draw in watts'),
  allocatedDraw: z.number().int().optional().describe('Allocated power draw in watts'),
  description: z.string().trim().optional().describe('Power port description'),
  deviceId: z.string().uuid().describe('Parent device UUID'),
});
export type CreateDcimPowerPortRequest = z.infer<typeof CreateDcimPowerPortRequestSchema>;

export const UpdateDcimPowerPortRequestSchema = z.object({
  name: z.string().min(1).optional().describe('Power port name'),
  type: DcimPowerPortTypeSchema.nullable().optional().describe('Power port connector type'),
  maximumDraw: z.number().int().nullable().optional().describe('Maximum power draw in watts'),
  allocatedDraw: z.number().int().nullable().optional().describe('Allocated power draw in watts'),
  description: z.string().trim().nullable().optional().describe('Power port description'),
});
export type UpdateDcimPowerPortRequest = z.infer<typeof UpdateDcimPowerPortRequestSchema>;

export const DcimPowerPortListQuerySchema = PaginationQuerySchema.extend({
  deviceId: z.string().uuid().optional().describe('Filter by device UUID'),
  type: DcimPowerPortTypeSchema.optional().describe('Filter by connector type'),
});
export type DcimPowerPortListQuery = z.infer<typeof DcimPowerPortListQuerySchema>;

export const DcimPowerPortListResponseSchema = createPaginatedResponseSchema(DcimPowerPortSchema);
export type DcimPowerPortListResponse = z.infer<typeof DcimPowerPortListResponseSchema>;

export const DcimPowerOutletSchema = z.object({
  id: z.string().uuid().describe('Power outlet UUID'),
  name: z.string().describe('Power outlet name'),
  type: DcimPowerOutletTypeSchema.nullable().describe('Power outlet connector type'),
  feedLegPhase: DcimFeedLegPhaseSchema.nullable().describe('Feed leg phase (A, B, or C)'),
  description: z.string().nullable().describe('Power outlet description'),
  deviceId: z.string().uuid().describe('Parent device UUID'),
  createdAt: z.coerce.date().describe('Creation timestamp'),
  updatedAt: z.coerce.date().describe('Last update timestamp'),
});
export type DcimPowerOutlet = z.infer<typeof DcimPowerOutletSchema>;

export const CreateDcimPowerOutletRequestSchema = z.object({
  name: z.string().min(1).describe('Power outlet name'),
  type: DcimPowerOutletTypeSchema.optional().describe('Power outlet connector type'),
  feedLegPhase: DcimFeedLegPhaseSchema.optional().describe('Feed leg phase'),
  description: z.string().trim().optional().describe('Power outlet description'),
  deviceId: z.string().uuid().describe('Parent device UUID'),
});
export type CreateDcimPowerOutletRequest = z.infer<typeof CreateDcimPowerOutletRequestSchema>;

export const UpdateDcimPowerOutletRequestSchema = z.object({
  name: z.string().min(1).optional().describe('Power outlet name'),
  type: DcimPowerOutletTypeSchema.nullable().optional().describe('Power outlet connector type'),
  feedLegPhase: DcimFeedLegPhaseSchema.nullable().optional().describe('Feed leg phase'),
  description: z.string().trim().nullable().optional().describe('Power outlet description'),
});
export type UpdateDcimPowerOutletRequest = z.infer<typeof UpdateDcimPowerOutletRequestSchema>;

export const DcimPowerOutletListQuerySchema = PaginationQuerySchema.extend({
  deviceId: z.string().uuid().optional().describe('Filter by device UUID'),
  type: DcimPowerOutletTypeSchema.optional().describe('Filter by connector type'),
  feedLegPhase: DcimFeedLegPhaseSchema.optional().describe('Filter by feed leg phase'),
});
export type DcimPowerOutletListQuery = z.infer<typeof DcimPowerOutletListQuerySchema>;

export const DcimPowerOutletListResponseSchema = createPaginatedResponseSchema(DcimPowerOutletSchema);
export type DcimPowerOutletListResponse = z.infer<typeof DcimPowerOutletListResponseSchema>;

export const DcimFrontPortSchema = z.object({
  id: z.string().uuid().describe('Front port UUID'),
  name: z.string().describe('Front port name'),
  type: DcimPortTypeSchema.describe('Front port connector type'),
  rearPortPosition: z.number().int().describe('Position on the rear port'),
  description: z.string().nullable().describe('Front port description'),
  deviceId: z.string().uuid().describe('Parent device UUID'),
  rearPortId: z.string().uuid().describe('Associated rear port UUID'),
  createdAt: z.coerce.date().describe('Creation timestamp'),
  updatedAt: z.coerce.date().describe('Last update timestamp'),
});
export type DcimFrontPort = z.infer<typeof DcimFrontPortSchema>;

export const CreateDcimFrontPortRequestSchema = z.object({
  name: z.string().min(1).describe('Front port name'),
  type: DcimPortTypeSchema.describe('Front port connector type'),
  rearPortPosition: z.number().int().min(1).optional().describe('Position on the rear port'),
  description: z.string().trim().optional().describe('Front port description'),
  deviceId: z.string().uuid().describe('Parent device UUID'),
  rearPortId: z.string().uuid().describe('Associated rear port UUID'),
});
export type CreateDcimFrontPortRequest = z.infer<typeof CreateDcimFrontPortRequestSchema>;

export const UpdateDcimFrontPortRequestSchema = z.object({
  name: z.string().min(1).optional().describe('Front port name'),
  type: DcimPortTypeSchema.optional().describe('Front port connector type'),
  rearPortPosition: z.number().int().min(1).optional().describe('Position on the rear port'),
  description: z.string().trim().nullable().optional().describe('Front port description'),
  rearPortId: z.string().uuid().optional().describe('Associated rear port UUID'),
});
export type UpdateDcimFrontPortRequest = z.infer<typeof UpdateDcimFrontPortRequestSchema>;

export const DcimFrontPortListQuerySchema = PaginationQuerySchema.extend({
  deviceId: z.string().uuid().optional().describe('Filter by device UUID'),
  rearPortId: z.string().uuid().optional().describe('Filter by rear port UUID'),
  type: DcimPortTypeSchema.optional().describe('Filter by connector type'),
});
export type DcimFrontPortListQuery = z.infer<typeof DcimFrontPortListQuerySchema>;

export const DcimFrontPortListResponseSchema = createPaginatedResponseSchema(DcimFrontPortSchema);
export type DcimFrontPortListResponse = z.infer<typeof DcimFrontPortListResponseSchema>;

export const DcimRearPortSchema = z.object({
  id: z.string().uuid().describe('Rear port UUID'),
  name: z.string().describe('Rear port name'),
  type: DcimPortTypeSchema.describe('Rear port connector type'),
  positions: z.number().int().describe('Number of front port positions'),
  description: z.string().nullable().describe('Rear port description'),
  deviceId: z.string().uuid().describe('Parent device UUID'),
  createdAt: z.coerce.date().describe('Creation timestamp'),
  updatedAt: z.coerce.date().describe('Last update timestamp'),
});
export type DcimRearPort = z.infer<typeof DcimRearPortSchema>;

export const CreateDcimRearPortRequestSchema = z.object({
  name: z.string().min(1).describe('Rear port name'),
  type: DcimPortTypeSchema.describe('Rear port connector type'),
  positions: z.number().int().min(1).optional().describe('Number of front port positions'),
  description: z.string().trim().optional().describe('Rear port description'),
  deviceId: z.string().uuid().describe('Parent device UUID'),
});
export type CreateDcimRearPortRequest = z.infer<typeof CreateDcimRearPortRequestSchema>;

export const UpdateDcimRearPortRequestSchema = z.object({
  name: z.string().min(1).optional().describe('Rear port name'),
  type: DcimPortTypeSchema.optional().describe('Rear port connector type'),
  positions: z.number().int().min(1).optional().describe('Number of front port positions'),
  description: z.string().trim().nullable().optional().describe('Rear port description'),
});
export type UpdateDcimRearPortRequest = z.infer<typeof UpdateDcimRearPortRequestSchema>;

export const DcimRearPortListQuerySchema = PaginationQuerySchema.extend({
  deviceId: z.string().uuid().optional().describe('Filter by device UUID'),
  type: DcimPortTypeSchema.optional().describe('Filter by connector type'),
});
export type DcimRearPortListQuery = z.infer<typeof DcimRearPortListQuerySchema>;

export const DcimRearPortListResponseSchema = createPaginatedResponseSchema(DcimRearPortSchema);
export type DcimRearPortListResponse = z.infer<typeof DcimRearPortListResponseSchema>;
