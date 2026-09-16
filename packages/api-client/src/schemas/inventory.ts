import { BillingFrequency } from '@repo/database/enums';
import { z } from 'zod';
import { IpxeBootUrlSchema } from './common';
import { availableLayersFields } from './customizations';
import { GpuTypeSchema } from './gpu';
import { zodEnumFromPrisma } from './prisma-enum';
import { customizationsField, provisionCommonFields, teeField } from './provision';

export const DeviceCategoriesSchema = GpuTypeSchema.describe('GPU or compute device category identifier');

export type DeviceCategory = z.infer<typeof DeviceCategoriesSchema>;

export const DeviceStockStatusEnum = z
  .enum(['on demand', 'reserve', 'preorder'])
  .describe('Current stock availability status for a device');

export type DeviceStockStatus = z.infer<typeof DeviceStockStatusEnum>;

export const InventoryListingsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1).describe('Page number for pagination'),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(12).describe('Number of items per page (1–100)'),
  filters: z
    .string()
    .optional()
    .describe(
      'Pipe-delimited filter expression "field:eq:value|field:eq:value". Only the "eq" operator is supported for inventory. Fields: category (GPU type enum), status ("on demand" | "reserve" | "preorder"), interruptibleReady ("true" | "false"). Repeating a field OR-combines values; different fields AND together.',
    ),
});

export type InventoryListingsQuery = z.infer<typeof InventoryListingsQuerySchema>;

const GpuSchema = z.object({
  model: z.string().nullable().describe('GPU model name'),
  count: z.number().nullable().describe('Number of GPUs installed'),
});

const StorageSpecSchema = z.object({
  hddCount: z.number().optional().nullable().describe('Number of HDD drives'),
  hddSize: z.number().optional().nullable().describe('Total HDD storage in bytes'),
  nvmeCount: z.number().optional().nullable().describe('Number of NVMe drives'),
  nvmeSize: z.number().optional().nullable().describe('Total NVMe storage in bytes'),
  ssdCount: z.number().optional().nullable().describe('Number of SSD drives'),
  ssdSize: z.number().optional().nullable().describe('Total SSD storage in bytes'),
  total: z.number().optional().nullable().describe('Total storage capacity in bytes'),
});

const InventoryListingCpuSchema = z.object({
  coresPerCpu: z.number().optional().nullable().describe('Number of physical cores per CPU socket'),
  count: z.number().optional().nullable().describe('Number of CPU sockets'),
  model: z.string().optional().nullable().describe('CPU model name'),
  threadsPerCore: z.number().optional().nullable().describe('Number of threads per physical core'),
  threadsPerCpu: z.number().optional().nullable().describe('Number of threads per CPU socket'),
  totalCores: z.number().optional().nullable().describe('Total physical cores across all sockets'),
  totalThreads: z.number().optional().nullable().describe('Total threads across all sockets'),
});

const PriceDetailSchema = z.object({
  perGpu: z.number().nullable().describe('Price per GPU unit'),
  perCpu: z.number().nullable().describe('Price per CPU unit'),
  total: z.number().nullable().describe('Total price for the device'),
});

const InventoryPriceSchema = z.object({
  perMonth: PriceDetailSchema.describe('Monthly pricing breakdown'),
  perWeek: PriceDetailSchema.describe('Weekly pricing breakdown'),
  perHour: PriceDetailSchema.describe('Hourly pricing breakdown'),
});

const StorageLayoutConfigSchema = z.object({
  disks: z
    .array(
      z.object({
        wwn: z.string().optional().nullable().describe('World Wide Name identifier for the disk'),
        name: z.string().describe('Device name (e.g. /dev/sda)'),
        serial: z.string().optional().nullable().describe('Disk serial number'),
      }),
    )
    .describe('Physical disks in this storage group'),
  disk_type: z.string().describe('Type of disk (e.g. NVMe, SSD, HDD)'),
  capabilities: z.array(z.string()).describe('Supported RAID or filesystem capabilities'),
  num_disks: z.number().describe('Number of disks in this group'),
  size_per_disk: z.number().describe('Storage capacity per disk in bytes'),
  disk_group_name: z.string().describe('Identifier for this disk group'),
  file_systems: z.array(z.string()).optional().describe('Supported filesystem types'),
});

const StorageLayoutDiskGroupSchema = z.object({
  config: z.string().describe('RAID configuration (e.g. RAID1, JBOD)'),
  file_system: z.string().describe('Filesystem type (e.g. ext4, xfs)'),
  group: z.string().describe('Disk group this layout applies to'),
  mountpoint: z.string().describe('Filesystem mount point'),
});

export const StorageLayoutsSchema = z.object({
  configs: z.array(StorageLayoutConfigSchema).describe('Available storage hardware configurations'),
  default: z
    .object({
      os_disks_group: StorageLayoutDiskGroupSchema.optional().nullable().describe('Default layout for OS disks'),
      data_disks_groups: z
        .array(StorageLayoutDiskGroupSchema)
        .optional()
        .nullable()
        .describe('Default layout for data disk groups'),
      cold_storage_disks_groups: z
        .array(StorageLayoutDiskGroupSchema)
        .optional()
        .nullable()
        .describe('Default layout for cold storage disk groups'),
    })
    .describe('Default disk layout configuration'),
});

export const DefaultDiskLayoutsSchema = z.array(
  z.object({
    config: z.string().describe('RAID configuration (e.g. RAID1, JBOD)'),
    format: z.string().describe('Filesystem format (e.g. ext4, xfs)'),
    mountpoint: z.string().describe('Filesystem mount point'),
    diskType: z.string().describe('Type of disk (e.g. NVMe, SSD, HDD)'),
    disks: z.array(z.string()).describe('List of disk device names'),
  }),
);

// Display identity only — internal org fields must not leak through public inventory endpoints.
const InviteeOrganizationSchema = z.object({
  id: z.string().describe('Unique identifier for the organization'),
  name: z.string().describe('Organization display name'),
});

export const InventoryReservationInvitesSchema = z.object({
  id: z.string().describe('Unique identifier for the reservation invite'),
  inviteeEmail: z.string().nullable().describe('Email address of the invited buyer'),
  inviterEmail: z.string().nullable().describe('Email address of the user who sent the invite'),
  inviteeOrganization: InviteeOrganizationSchema.nullable().describe('Organization receiving the reservation invite'),
  price: z.number().nullable().describe('Agreed-upon price'),
  billingFrequency: zodEnumFromPrisma(BillingFrequency).describe('How often the buyer is billed'),
  invoiceDueDays: z.number().optional().describe('Number of days until invoice is due'),
  interruptibleNoticePeriod: z
    .number()
    .optional()
    .nullable()
    .describe('The notice period in milliseconds for interruptible deployments'),
  dateCreated: z.string().describe('ISO 8601 timestamp when the invite was created'),
  dateExpires: z.string().describe('ISO 8601 timestamp when the invite expires'),
});

export const InventoryListingSchema = z.object({
  id: z.string().uuid().describe('Unique device identifier'),
  name: z.string().describe('Device display name'),
  location: z.string().nullable().describe('Data center or region where the device is located'),
  role: z.string().describe('Device role classification'),
  stockStatus: DeviceStockStatusEnum.describe('Current stock availability status'),
  isTeeCapable: z.boolean().describe('Whether the device supports Trusted Execution Environment'),
  specs: z
    .object({
      cpu: InventoryListingCpuSchema.describe('CPU hardware specifications'),
      gpu: GpuSchema.describe('GPU hardware specifications'),
      memory: z
        .object({
          total: z.number().nullable().describe('Total memory in GB'),
        })
        .describe('Memory specifications'),
      storage: StorageSpecSchema.describe('Storage hardware specifications'),
    })
    .describe('Hardware specifications for the device'),
  networking: z
    .object({
      ipv4: z.string().optional().nullable().describe('Primary IPv4 address'),
      ipv6: z.string().optional().nullable().describe('Primary IPv6 address'),
      networkType: z.string().describe('Network connection type'),
      vpcCapable: z.boolean().describe('Whether the device supports VPC networking'),
    })
    .describe('Network configuration and capabilities'),
  listing: z
    .object({
      isInterruptibleOnly: z.boolean().describe('Whether the device is only available as interruptible'),
      isActive: z.boolean().describe('Whether the listing is currently active'),
      onDemandPrice: InventoryPriceSchema.describe('Pricing for on-demand contracts'),
      interruptiblePrice: InventoryPriceSchema.describe('Pricing for interruptible contracts'),
    })
    .describe('Marketplace listing details and pricing'),
  activeReservationInvite: InventoryReservationInvitesSchema.optional()
    .nullable()
    .describe(
      'Active reservation invite, returned only to the counterparty on interactive requests. Always null in webhook (system-context) deliveries.',
    ),
  ...availableLayersFields,
  storageLayouts: StorageLayoutsSchema.describe('Storage hardware layout and configuration options'),
  defaultDiskLayouts: DefaultDiskLayoutsSchema.describe('Pre-configured default disk layouts'),
  isInterruptibleDeployment: z.boolean().describe('Whether the current deployment is interruptible'),
  interruptibleNoticePeriod: z
    .number()
    .optional()
    .nullable()
    .describe('Notice period in milliseconds before interruption'),
  availableAt: z.string().describe('ISO 8601 date when the device becomes available'),
});

export type InventoryListing = z.infer<typeof InventoryListingSchema>;
export type InventoryReservationInvite = z.infer<typeof InventoryReservationInvitesSchema>;

export const CategoryPriceSchema = z.object({
  category: z.string().describe('GPU or compute device category identifier'),
  startPrice: z.number().describe('Lowest available price for this category'),
});

export type CategoryPrice = z.infer<typeof CategoryPriceSchema>;

export const CategoryAvailabilitySchema = z.object({
  category: z.string().describe('GPU or compute device category identifier'),
  hasOnDemand: z.boolean().describe('Whether on-demand stock is currently available for this category'),
  onDemandCount: z.number().int().describe('Number of on-demand devices available in this category'),
  hasReserve: z.boolean().describe('Whether reservable stock is currently available for this category'),
  reserveCount: z.number().int().describe('Number of reservable devices in this category'),
  hasPreorder: z.boolean().describe('Whether pre-order stock is available for this category'),
  preorderCount: z.number().int().describe('Number of pre-order devices in this category'),
});

export type CategoryAvailability = z.infer<typeof CategoryAvailabilitySchema>;

export const RegionSchema = z.object({
  name: z.string().describe('Region display name'),
});

export type Region = z.infer<typeof RegionSchema>;

export type { DiskLayout } from './provision';

export const ProvisionRequestSchema = z.object({
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

export type ProvisionRequest = z.infer<typeof ProvisionRequestSchema>;

export const ProvisionResponseSchema = z.object({
  success: z.boolean().describe('Whether provisioning was initiated successfully'),
  jobId: z
    .string()
    .uuid()
    .optional()
    .describe('Identifier of the lifecycle job created by this action; correlate it with the job history endpoint'),
});

export type ProvisionResponse = z.infer<typeof ProvisionResponseSchema>;
