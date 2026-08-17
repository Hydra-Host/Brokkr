import { DeviceRole, DeviceType } from '@repo/database';
import { z } from 'zod';

export const StorageDiskSchema = z.object({
  wwn: z.string().nullable().optional(),
  name: z.string(),
  serial: z.string().nullable().optional(),
});

export type StorageDisk = z.infer<typeof StorageDiskSchema>;

export const StorageConfigSchema = z.object({
  disks: z.array(StorageDiskSchema),
  disk_type: z.string(),
  num_disks: z.number(),
  capabilities: z.array(z.string()),
  file_systems: z.array(z.string()).optional(),
  size_per_disk: z.number(),
  disk_group_name: z.string(),
});

export type StorageConfig = z.infer<typeof StorageConfigSchema>;

export const DiskGroupAssignmentSchema = z.object({
  group: z.string(),
  config: z.string(),
  mountpoint: z.string(),
  file_system: z.string(),
});

export type DiskGroupAssignment = z.infer<typeof DiskGroupAssignmentSchema>;

export const StorageLayoutSchema = z.object({
  configs: z.array(StorageConfigSchema),
  default: z.object({
    os_disks_group: DiskGroupAssignmentSchema.optional().nullable(),
    data_disks_groups: z.array(DiskGroupAssignmentSchema).optional().nullable(),
    cold_storage_disks_groups: z.array(DiskGroupAssignmentSchema).optional().nullable(),
  }),
});

export type StorageLayout = z.infer<typeof StorageLayoutSchema>;

export const StorageLayoutsSchema = z.union([StorageLayoutSchema, z.object({}).strict()]);

export type StorageLayouts = z.infer<typeof StorageLayoutsSchema>;

export const IpamConfigSchema = z.object({}).passthrough().nullable();
export const VirtualNetworkConfigSchema = z.object({}).passthrough().nullable();

export type IpamConfig = z.infer<typeof IpamConfigSchema>;
export type VirtualNetworkConfig = z.infer<typeof VirtualNetworkConfigSchema>;

export const DeviceMetadataSchema = z.object({
  id: z.number(),
  name: z.string(),
  status: z.string(),
  serial: z.string(),
  role: z.nativeEnum(DeviceRole),
  regionName: z.string(),
  clusterId: z.number().nullable(),
  clusterName: z.string().nullable(),
  primaryIp4: z.string(),
  primaryIp6: z.string(),
  cpuModel: z.string(),
  cpuThreadCount: z.number(),
  cpuCoreCount: z.number(),
  cpuPhysicalCount: z.number(),
  ipamConfig: IpamConfigSchema,
  virtualNetworkConfig: VirtualNetworkConfigSchema,
  macAddress: z.string(),
  memory: z.number(),
  nvmeSize: z.number().nullable().optional(),
  nvmeCount: z.number().nullable().optional(),
  ssdSize: z.number(),
  ssdCount: z.number(),
  hddSize: z.number().nullable().optional(),
  hddCount: z.number().nullable().optional(),
  gpuModel: z.string().nullable().optional(),
  gpuCount: z.number().nullable().optional(),
  deviceId: z.string().uuid(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type DeviceMetadata = z.infer<typeof DeviceMetadataSchema>;

export const ReservationDeviceSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  nickname: z.string(),
  supplierId: z.string().uuid(),
  supplier: z.object({
    id: z.string(),
    name: z.string(),
    tenantType: z.string(),
    logo: z.string().nullable(),
  }),
  deviceType: z.nativeEnum(DeviceType),
  price: z.number(),
  isListed: z.boolean(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  storageLayouts: StorageLayoutsSchema,
  skuId: z.string().uuid(),
  metadata: DeviceMetadataSchema,
});

export type ReservationDevice = z.infer<typeof ReservationDeviceSchema>;

export const ReservationDeploymentSchema = z.object({
  id: z.string().uuid(),
  nickname: z.string(),
  startDate: z.coerce.date(),
  endDate: z.coerce.date().nullable().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date().nullable().optional(),
  type: z.string(),
  deviceId: z.string().uuid(),
  baseLayerId: z.string().uuid().nullable(),
  reservationId: z.string().uuid(),
  device: ReservationDeviceSchema,
});

export type ReservationDeployment = z.infer<typeof ReservationDeploymentSchema>;
