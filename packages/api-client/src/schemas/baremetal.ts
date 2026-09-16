import { BillingFrequency, DeviceStatus } from '@repo/database/enums';
import { z } from 'zod';
import { BooleanQueryParamSchema, IpxeBootUrlSchema } from './common';
import { availableLayersFields } from './customizations';
import { InterfaceSchema } from './interface';
import { IpxeBuildTargetSchema } from './ipam';
import { PaginationQuerySchema } from './pagination';
import { zodEnumFromPrisma } from './prisma-enum';
import { customizationsField, provisionCommonFields, teeField } from './provision';

const BillingFrequencySchema = zodEnumFromPrisma(BillingFrequency).describe('Billing cadence for the reservation');

const DeviceRoleValues = [
  'Hypervisor',
  'Baremetal',
  'Cluster',
  'Bridge',
  'VM',
  'Decommissioned',
  'DiscoveredHost',
  'OffMarketplaceHost',
] as const;

const DeviceRoleSchema = z.preprocess((val) => {
  if (typeof val !== 'string') return val;
  return DeviceRoleValues.find((role) => role.toLowerCase() === val.toLowerCase()) ?? val;
}, z.enum(DeviceRoleValues));

const DeviceStatusSchema = z.preprocess((val) => {
  if (typeof val !== 'string') return val;
  return (Object.values(DeviceStatus) as string[]).find((s) => s.toLowerCase() === val.toLowerCase()) ?? val;
}, zodEnumFromPrisma(DeviceStatus));

const statusSchema = z.object({
  value: z.string().describe('Machine-readable status identifier'),
  label: z.string().describe('Human-readable status label'),
});

const customerSchema = z.object({
  deviceName: z.string().nullable().optional().describe('Customer-assigned device name'),
  organizationId: z.string().nullable().optional().describe('Organization ID of the current tenant'),
  provisionedDate: z.string().nullable().optional().describe('ISO 8601 date when the device was provisioned'),
  sshPubKeys: z.string().nullable().optional().describe('SSH public keys installed on the device'),
  sshPubKeysIds: z.string().nullable().optional().describe('Comma-separated IDs of installed SSH keys'),
  userId: z.string().nullable().optional().describe('User ID of the deployer'),
  reservationType: z.string().nullable().optional().describe('Type of reservation currently active on the device'),
});

const dcimInfoSchema = z.object({
  nickname: z.string().nullable().optional().describe('Operator-assigned nickname for the device'),
});

const priceDetailSchema = z.object({
  perGpu: z.number().nullable().optional().describe('Price per GPU unit'),
  perCpu: z.number().nullable().optional().describe('Price per CPU unit'),
  total: z.number().nullable().optional().describe('Total price for all compute units'),
});

const listingSchema = z.object({
  isInterruptibleOnly: z
    .boolean()
    .nullable()
    .optional()
    .describe('Whether the listing only accepts interruptible reservations'),
  isActive: z.boolean().nullable().optional().describe('Whether the listing is currently visible on the marketplace'),
  isPrivate: z.boolean().nullable().optional().describe('Whether the listing is restricted to invited buyers'),
  invitee: z.string().nullable().optional().describe('Email of the invited buyer for private listings'),
  onDemandPrice: z
    .object({
      perMonth: priceDetailSchema.describe('Monthly on-demand pricing breakdown'),
      perWeek: priceDetailSchema.describe('Weekly on-demand pricing breakdown'),
      perHour: priceDetailSchema.describe('Hourly on-demand pricing breakdown'),
    })
    .describe('On-demand pricing tiers'),
  interruptiblePrice: z
    .object({
      perMonth: priceDetailSchema.describe('Monthly interruptible pricing breakdown'),
      perWeek: priceDetailSchema.describe('Weekly interruptible pricing breakdown'),
      perHour: priceDetailSchema.describe('Hourly interruptible pricing breakdown'),
    })
    .describe('Interruptible (spot) pricing tiers'),
});

const networkingSchema = z.object({
  downloadSpeed: z.number().nullable().optional().describe('Network download speed in Mbps'),
  ipv4: z.string().nullable().optional().describe('Primary IPv4 address'),
  ipv6: z.string().nullable().optional().describe('Primary IPv6 address'),
  mac: z.string().nullable().optional().describe('Primary network interface MAC address'),
  uploadSpeed: z.number().nullable().optional().describe('Network upload speed in Mbps'),
  ipmiIp: z.string().nullable().optional().describe('IPMI/BMC management IP address'),
  vpcCapable: z.boolean().nullable().optional().describe('Whether the device supports VPC networking'),
});

const specsSchema = z.object({
  cpu: z
    .object({
      coresPerCpu: z.number().nullable().optional().describe('Number of physical cores per CPU socket'),
      count: z.number().nullable().optional().describe('Number of CPU sockets'),
      model: z.string().nullable().optional().describe('CPU model name (e.g. "AMD EPYC 7742")'),
      threadsPerCore: z.number().nullable().optional().describe('Number of hardware threads per core'),
      threadsPerCpu: z.number().nullable().optional().describe('Total threads per CPU socket'),
      totalCores: z.number().nullable().optional().describe('Total physical cores across all sockets'),
      totalThreads: z.number().nullable().optional().describe('Total hardware threads across all sockets'),
    })
    .describe('CPU specifications'),
  gpu: z
    .object({
      count: z.number().nullable().optional().describe('Number of GPUs installed'),
      model: z.string().nullable().optional().describe('GPU model name (e.g. "NVIDIA H100 SXM")'),
    })
    .describe('GPU specifications'),
  memory: z
    .object({
      total: z.number().nullable().optional().describe('Total system memory in GB'),
    })
    .describe('Memory specifications'),
  storage: z
    .object({
      hddCount: z.number().nullable().optional().describe('Number of HDD drives'),
      hddSize: z.number().nullable().optional().describe('Total HDD capacity in GB'),
      nvmeCount: z.number().nullable().optional().describe('Number of NVMe drives'),
      nvmeSize: z.number().nullable().optional().describe('Total NVMe capacity in GB'),
      ssdCount: z.number().nullable().optional().describe('Number of SATA SSD drives'),
      ssdSize: z.number().nullable().optional().describe('Total SATA SSD capacity in GB'),
      total: z.number().nullable().optional().describe('Total storage capacity across all drive types in GB'),
    })
    .describe('Storage specifications'),
});

const tenantSchema = z.object({
  name: z.string().describe('Tenant organization name'),
  slug: z.string().describe('URL-friendly tenant identifier'),
  id: z.string().describe('Unique tenant ID'),
});

const diskSchema = z.object({
  wwn: z.string().nullable().optional().describe('World Wide Name unique disk identifier'),
  name: z.string().describe('Device name (e.g. "/dev/sda", "/dev/nvme0n1")'),
  serial: z.string().nullable().optional().describe('Disk serial number'),
});

const storageLayoutConfigSchema = z.object({
  disks: z.array(diskSchema).describe('Physical disks included in this group'),
  disk_type: z.string().describe('Drive technology type (e.g. "nvme", "ssd", "hdd")'),
  capabilities: z.array(z.string()).describe('Supported RAID/filesystem capabilities for this disk group'),
  num_disks: z.number().describe('Number of disks in this group'),
  size_per_disk: z.number().describe('Capacity per disk in bytes'),
  disk_group_name: z.string().describe('Logical name for this disk group'),
  file_systems: z.array(z.string()).optional().describe('Supported filesystem types for this group'),
});

const storageLayoutDiskGroupSchema = z.object({
  config: z.string().describe('RAID or storage configuration (e.g. "raid0", "single")'),
  file_system: z.string().describe('Filesystem type to format with (e.g. "ext4", "xfs")'),
  group: z.string().describe('Disk group name this layout applies to'),
  mountpoint: z.string().describe('Filesystem mount point (e.g. "/", "/data")'),
});

const storageLayoutsSchema = z.object({
  configs: z.array(storageLayoutConfigSchema).describe('Available disk group configurations'),
  default: z
    .object({
      os_disks_group: storageLayoutDiskGroupSchema
        .nullable()
        .optional()
        .describe('Default disk group layout for the OS partition'),
      data_disks_groups: z
        .array(storageLayoutDiskGroupSchema)
        .nullable()
        .optional()
        .describe('Default disk group layouts for data partitions'),
      cold_storage_disks_groups: z
        .array(storageLayoutDiskGroupSchema)
        .nullable()
        .optional()
        .describe('Default disk group layouts for cold storage partitions'),
    })
    .describe('Default storage layout presets'),
});

const defaultDiskLayoutSchema = z.object({
  config: z.string().describe('RAID or storage configuration'),
  format: z.string().describe('Filesystem format (e.g. "ext4")'),
  mountpoint: z.string().describe('Filesystem mount point'),
  diskType: z.string().describe('Drive technology type'),
  disks: z.array(z.string()).describe('List of device names included in this layout'),
});

const reservationDataSchema = z.object({
  price: z.number().describe('Total price charged per billing period'),
  pricePerGpuHour: z.number().nullable().optional().describe('Per-GPU hourly rate charged'),
  pricePerDeviceHour: z
    .number()
    .nullable()
    .describe('Per-device hourly rate charged; null when the billing cadence has no hourly equivalent'),
  billingFrequency: z.string().describe('How often the buyer is billed (e.g. "HOURLY", "WEEKLY")'),
});

const activeDeploymentSchema = z.object({
  deployerEmail: z.string().nullable().optional().describe('Email of the user who deployed the device'),
  reservation: reservationDataSchema.nullable().optional().describe('Active reservation details, if any'),
});

const reservationInviteDataSchema = z.object({
  id: z.string().describe('Unique identifier for the reservation invite'),
  inviteeEmail: z.string().nullable().optional().describe('Email of the invited buyer'),
  price: z.number().describe('Total price charged per billing period'),
  pricePerGpuHour: z.number().nullable().optional().describe('Per-GPU hourly rate charged'),
  pricePerDeviceHour: z
    .number()
    .nullable()
    .describe('Per-device hourly rate charged; null when the billing cadence has no hourly equivalent'),
  billingFrequency: z.string().describe('Billing cadence for this invite'),
  dateCreated: z.coerce.date().describe('When the invite was created'),
  dateExpires: z.coerce.date().nullable().optional().describe('When the invite expires, or null if no expiry'),
  dateAccepted: z.coerce.date().nullable().optional().describe('When the invite was accepted by the buyer'),
  dateDeleted: z.coerce.date().nullable().optional().describe('When the invite was soft-deleted'),
  interruptibleNoticePeriod: z
    .number()
    .nullable()
    .optional()
    .describe('Required notice period in hours before interrupting the reservation'),
});

export const ServerSchema = z.object({
  id: z.string().describe('Unique device identifier'),
  name: z.string().describe('Device name'),
  role: z.string().describe('Device role (e.g. "gpu_server", "bridge")'),
  zoneName: z.string().describe('Zone name the device belongs to'),
  status: statusSchema.describe('Current device lifecycle status'),
  powerStatus: statusSchema.describe('Current power state of the device'),
  customer: customerSchema.describe('Customer/tenant deployment information'),
  dcim: dcimInfoSchema.describe('DCIM metadata'),
  listing: listingSchema.describe('Marketplace listing and pricing information'),
  networking: networkingSchema.describe('Network configuration and addresses'),
  interfaces: z.array(InterfaceSchema).describe('Network interfaces attached to the server'),
  specs: specsSchema.describe('Hardware specifications'),
  tenant: tenantSchema.describe('Tenant organization that owns the device'),
  ...availableLayersFields,
  storageLayouts: storageLayoutsSchema.describe('Available and default storage layout configurations'),
  defaultDiskLayouts: z.array(defaultDiskLayoutSchema).describe('Pre-configured default disk layout options'),
  deployment: activeDeploymentSchema
    .nullable()
    .optional()
    .describe('Active deployment details, if the device is currently deployed'),
  reservationInvite: reservationInviteDataSchema
    .nullable()
    .optional()
    .describe('Pending reservation invite, if one exists'),
  ecoMode: z.boolean().default(false).describe('Whether eco mode (power-saving when idle) is enabled'),
  ipxeBuildTarget: IpxeBuildTargetSchema.nullable()
    .optional()
    .describe('Per-device PXE boot firmware override. Null means inherit from prefix or system default.'),
  isTeeCapable: z.boolean().default(false).describe('Whether the device supports Trusted Execution Environment'),
  isHealthy: z
    .boolean()
    .nullable()
    .describe('Device health status based on latest GPU burn-in test and bridge health check'),
  deletedAt: z
    .string()
    .nullable()
    .describe(
      'Soft-delete timestamp (ISO-8601), or null for a live device. Post-MTI a decommissioned host is a soft-deleted Server, so a non-null value means the device is decommissioned.',
    ),
});

export type Server = z.infer<typeof ServerSchema>;

export const ServerFilterOptionsSchema = z.object({
  gpuCounts: z
    .array(z.number())
    .describe('Distinct GPU counts present across the fleet, for the GPU-count filter dropdown.'),
  gpuModels: z
    .array(z.string())
    .describe('Distinct GPU model names present across the fleet, for the GPU-model filter dropdown.'),
  memorySizes: z
    .array(z.number())
    .describe('Distinct total RAM sizes in GB present across the fleet, for the memory filter dropdown.'),
  statuses: z
    .array(z.string())
    .describe('Distinct device status enum values (filter tokens, not display labels) present across the fleet.'),
  healthStates: z
    .array(z.string())
    .describe('Available health-state filter labels ("Healthy" / "Unhealthy") shown in the dropdown.'),
});

export type ServerFilterOptions = z.infer<typeof ServerFilterOptionsSchema>;

export const ServerFilterOptionsQuerySchema = z.object({
  role: DeviceRoleSchema.optional().describe('Filter devices by role (e.g. "Baremetal"), case-insensitive.'),
});

export type ServerFilterOptionsQuery = z.infer<typeof ServerFilterOptionsQuerySchema>;

export const ServersQuerySchema = PaginationQuerySchema.extend({
  role: DeviceRoleSchema.optional().describe(
    'Filter devices by role. Accepts any DeviceRole value case-insensitively (e.g. "baremetal", "Baremetal", "BAREMETAL").',
  ),
  status: DeviceStatusSchema.optional().describe(
    'Filter devices by lifecycle status. Accepts any DeviceStatus value case-insensitively (PLANNED, STAGED, ACTIVE, MAINTENANCE).',
  ),
  decommissioned: BooleanQueryParamSchema.optional().describe(
    'When true, return decommissioned (soft-deleted) hosts instead of live ones. Post-MTI, a decommissioned host is a soft-deleted Server (deletedAt set), so this flips the listing from live devices to tombstoned ones.',
  ),
});

export type ServersQuery = z.infer<typeof ServersQuerySchema>;

export const UpdateListingRequestSchema = z
  .object({
    hourlyPrice: z.number().describe('On-demand hourly price in USD'),
    floorHourlyPrice: z.number().optional().describe('Minimum interruptible hourly price in USD'),
    billingFrequency: z.enum(['Weekly']).describe('Billing frequency for the listing'),
    isListed: z.boolean().describe('Whether the device should be visible on the marketplace'),
    isInterruptibleOnly: z.boolean().optional().describe('Whether to only accept interruptible reservations'),
  })
  .superRefine((data, ctx) => {
    if (data.hourlyPrice <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Price cannot be $0.00',
        path: ['hourlyPrice'],
      });
    }
  })
  .superRefine((data, ctx) => {
    if (data.floorHourlyPrice !== undefined && data.floorHourlyPrice <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Floor price cannot be $0.00',
        path: ['floorHourlyPrice'],
      });
    }
  })
  .superRefine((data, ctx) => {
    if (data.floorHourlyPrice && data.floorHourlyPrice > data.hourlyPrice) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Floor price cannot be greater than on demand price',
        path: ['floorHourlyPrice'],
      });
    }
  });

export type UpdateListingRequest = z.infer<typeof UpdateListingRequestSchema>;

export const UpdateNicknameRequestSchema = z.object({
  nickname: z.string().describe('New nickname to assign to the device'),
});

export type UpdateNicknameRequest = z.infer<typeof UpdateNicknameRequestSchema>;

export const UpdateServerInfoRequestSchema = z.object({
  nickname: z.string().optional().describe('New nickname for the device'),
  ecoMode: z.boolean().optional().describe('Whether to enable eco mode (power-saving when idle)'),
  ipxeBuildTarget: IpxeBuildTargetSchema.nullable()
    .optional()
    .describe(
      'Per-device PXE boot firmware override. Null clears the override (inherits from prefix). ' +
        'Omit to leave unchanged.',
    ),
});

export type UpdateServerInfoRequest = z.infer<typeof UpdateServerInfoRequestSchema>;

export const CommissionServerRequestSchema = z.object({
  id: z.string().describe('Brokkr Device UUID to commission'),
  macAddress: z.string().describe('Primary network interface MAC address'),
  ipmiLogin: z.string().describe('IPMI/BMC login username'),
  ipmiPassword: z.string().describe('IPMI/BMC login password'),
});

export type CommissionServerRequest = z.infer<typeof CommissionServerRequestSchema>;

export const ProvisionServerRequestSchema = z.object({
  ...provisionCommonFields,
  ...customizationsField,
  ...teeField,
  isInterruptible: z
    .boolean()
    .optional()
    .describe('Whether the deployment is interruptible (re-rentable via eviction)'),
  projectId: z.string().optional().describe('Project to assign the deployment to'),
  ipxeUrl: IpxeBootUrlSchema.optional().nullable(),
});

export type ProvisionServerRequest = z.infer<typeof ProvisionServerRequestSchema>;

const MAX_INTERRUPTIBLE_NOTICE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

export const CreateReservationInviteRequestSchema = z.object({
  inviterEmail: z.string().email().describe('Email of the admin or supplier creating the invite'),
  inviteeEmail: z.string().email().describe('Email of the buyer being invited'),
  organizationId: z.string().describe('Organization ID of the supplier'),
  price: z.number().nonnegative().describe('Total price per billing period'),
  billingFrequency: BillingFrequencySchema.describe('How often the buyer will be billed'),
  dateExpires: z.coerce.date().describe('When the invite expires'),
  deviceIds: z.array(z.string()).describe('Device IDs included in this reservation'),
  notes: z.string().optional().describe('Internal notes about the reservation invite'),
  interruptibleNoticePeriod: z
    .number()
    .nonnegative()
    .max(MAX_INTERRUPTIBLE_NOTICE_PERIOD_MS)
    .nullable()
    .optional()
    .describe('Notice period (ms) before interruption; capped at 7 days'),
});

export type CreateReservationInviteRequest = z.infer<typeof CreateReservationInviteRequestSchema>;

export const EditReservationInviteRequestSchema = z.object({
  price: z.number().nonnegative().describe('Updated price per billing period'),
  billingFrequency: BillingFrequencySchema.describe('Updated billing frequency'),
  dateExpires: z.coerce.date().describe('Updated expiration date'),
  deviceIds: z.array(z.string()).describe('Updated list of device IDs'),
  notes: z.string().optional().describe('Updated internal notes'),
  interruptibleNoticePeriod: z
    .number()
    .nonnegative()
    .max(MAX_INTERRUPTIBLE_NOTICE_PERIOD_MS)
    .nullable()
    .optional()
    .describe('Updated notice period (ms) before interruption; capped at 7 days'),
});

export type EditReservationInviteRequest = z.infer<typeof EditReservationInviteRequestSchema>;

export const ServerUpdateResponseSchema = z.object({
  success: z.boolean().describe('Whether the device update operation succeeded'),
});

export type ServerUpdateResponse = z.infer<typeof ServerUpdateResponseSchema>;

export const ProvisionBaremetalResponseSchema = ServerUpdateResponseSchema.extend({
  jobId: z
    .string()
    .uuid()
    .optional()
    .describe('Identifier of the lifecycle job created by this provision; correlate it with the job history endpoint'),
});

export type ProvisionBaremetalResponse = z.infer<typeof ProvisionBaremetalResponseSchema>;

export const CollectInventoryResponseSchema = z.object({
  jobId: z
    .string()
    .describe(
      'Stable per-device collection job id. Collection is coalesced per device, so a request made while a collection is already running returns the same id instead of starting a duplicate. The run is asynchronous — the bridge waits for Brokkr Live, collects hardware, and reports back via discovery.complete.',
    ),
});

export type CollectInventoryResponse = z.infer<typeof CollectInventoryResponseSchema>;

export const ReservationBaremetalInviteSchema = z.object({
  buyerEmail: z.string().optional().describe('Email of the buyer who accepted the reservation'),
  supplierName: z.string().optional().describe('Name of the supplier organization'),
  primaryIp4: z.string().optional().describe('Primary IPv4 address of the reserved device'),
  primaryIp6: z.string().optional().describe('Primary IPv6 address of the reserved device'),
  startDate: z.string().describe('ISO 8601 date when the reservation starts'),
  inviteExpires: z.string().nullable().describe('ISO 8601 date when the invite expires, or null if no expiry'),
  gpuModel: z.string().optional().describe('GPU model of the reserved device'),
  gpuCount: z.number().optional().describe('Number of GPUs in the reserved device'),
  price: z.number().nullable().describe('Total price per billing period'),
  billingFrequency: z.string().describe('Billing cadence for the reservation'),
  reservationType: z.enum(['Pending', 'Active', 'Past']).describe('Current lifecycle stage of the reservation'),
  deviceMetadataId: z.number().optional().describe('Internal device metadata record ID'),
  orgId: z.string().optional().describe('Organization ID of the supplier'),
});

export type ReservationBaremetalInvite = z.infer<typeof ReservationBaremetalInviteSchema>;
