import type {
  Device,
  FirmwareType,
  GpuCcMode,
  GpuVendor,
  InterfaceLinkType,
  InterfaceType,
  MemoryEccType,
  MemoryType,
  Prisma,
  Server,
  SolResolvedSource,
  StorageDriveType,
  TeeCapability,
} from '@repo/database';
import type { LoggerService } from 'src/logger/logger.service';
import type { ZodType } from 'zod';

export const COLLECTOR_NAMES = [
  'architecture',
  'bdi',
  'bmc',
  'collection_metadata',
  'dmidecode',
  'dmidecode_memory',
  'efi',
  'efibootmgr',
  'firmware_type',
  'ghw_baseboard',
  'ghw_bios',
  'ghw_block',
  'ghw_chassis',
  'ghw_cpu',
  'ghw_gpu',
  'ghw_memory',
  'ghw_net',
  'ghw_pci',
  'ghw_product',
  'ib_data',
  'ip_a',
  'kernel_params',
  'lldp',
  'lsblk',
  'lscpu',
  'lshw',
  'nvidia',
  'public_ip',
  'route',
  'serial_ports',
  'virtualization',
] as const;

export type CollectorNameV2 = (typeof COLLECTOR_NAMES)[number];

export type RawCollectorBundle = Partial<Record<CollectorNameV2, unknown>> & Record<string, unknown>;

export interface CollectorContext {
  runId: string;
  deviceId: string;
  device: Device & { server: Server | null };
  rawBundle: RawCollectorBundle;
  logger: LoggerService;
}

export interface DeviceMutation {
  deviceUpdate?: Prisma.DeviceUpdateInput;
  serverUpdate?: ServerMutation;
  upserts?: MutationUpserts;
  warnings?: string[];
}

export interface ServerMutation {
  teeCapable?: TeeCapability;
  storageLayouts?: Prisma.InputJsonValue;
  kernelCmdline?: string | null;
}

export interface MutationUpserts {
  cpus?: CpuUpsert[];
  gpus?: GpuUpsert[];
  storageDrives?: StorageDriveUpsert[];
  memoryConfig?: MemoryConfigUpsert;
  interfaces?: InterfaceUpsert[];
  firmwares?: DeviceFirmwareUpsert[];
  pciDevices?: PciDeviceUpsert[];
  uefiBootEntries?: UefiBootEntryUpsert[];
  nvlinkEdges?: NvlinkEdgeUpsert[];
  solConfig?: DeviceSolConfigUpsert;
  natMappings?: NatMappingUpsert[];
}

export interface NatMappingUpsert {
  outsideAddress: string;
  insideAddress: string;
}

export interface CpuUpsert {
  socketIndex: number;
  model: string;
  vendor?: string | null;
  architecture?: string | null;
  coreCount?: number | null;
  threadCount?: number | null;
  capabilities?: string[];
}

export interface GpuUpsert {
  index: number;
  model: string;
  vendor: GpuVendor;
  uuid?: string | null;
  vbiosVersion?: string | null;
  serial?: string | null;
  pciBusId?: string | null;
  memoryTotalMb?: number | null;
  eccEnabled?: boolean | null;
  pcieLinkGen?: number | null;
  pcieLinkWidth?: number | null;
  powerLimitW?: number | null;
  powerLimitMaxW?: number | null;
  driverVersion?: string | null;
  computeCapability?: string | null;
  architecture?: string | null;
  migMode?: boolean | null;
  migProfile?: string | null;
  ccMode?: GpuCcMode | null;
}

export interface StorageDriveUpsert {
  name: string;
  type: StorageDriveType;
  model?: string | null;
  serial?: string | null;
  wwn?: string | null;
  sizeBytes: bigint;
  physicalBlockBytes?: number | null;
  busPath?: string | null;
  storageController?: string | null;
}

export interface MemoryConfigUpsert {
  totalSizeMb: number;
  populatedDimms: number;
  totalSlots: number;
  dimmSizeMb?: number | null;
  dimmType?: MemoryType | null;
  dimmSpeed?: string | null;
  configuredSpeed?: string | null;
  eccType?: MemoryEccType | null;
  configSummary?: string | null;
}

export interface InterfaceUpsert {
  name: string;
  type?: InterfaceType | null;
  enabled?: boolean;
  mtu?: number | null;
  macAddress?: string | null;
  speed?: number | null;
  mgmtOnly?: boolean;
  description?: string | null;
  linkType?: InterfaceLinkType | null;
  guid?: string | null;
  portState?: string | null;
  maxSpeedGbps?: number | null;
  pciDeviceId?: string | null;
  lldpNeighborName?: string | null;
  lldpNeighborPort?: string | null;
  lldpNeighborDescr?: string | null;
  lldpNeighborMgmtIp?: string | null;
  driver?: string | null;
  operstate?: string | null;
  linkOperUp?: boolean | null;
  linkPhysicalUp?: boolean | null;
  ipAddresses?: string[];
}

export interface DeviceFirmwareUpsert {
  type: FirmwareType;
  vendor?: string | null;
  version: string;
  date?: string | null;
}

export interface PciDeviceUpsert {
  address: string;
  vendorId: string;
  vendorName?: string | null;
  productId: string;
  productName?: string | null;
  className?: string | null;
  subclassName?: string | null;
  driver?: string | null;
  subsystemVendorId?: string | null;
  subsystemProductId?: string | null;
}

export interface UefiBootEntryUpsert {
  bootOptionReference: string;
  displayName: string;
  uefiDevicePath?: string | null;
  enabled: boolean;
  bootOrderIndex?: number | null;
  isCurrent: boolean;
}

export interface NvlinkEdgeUpsert {
  sourceGpuIndex: number;
  targetGpuIndex: number;
  lanes?: number | null;
  bandwidthGbps?: number | null;
  linkStatus?: string | null;
}

export interface DeviceSolConfigUpsert {
  solCapable?: boolean | null;
  solEnabled?: boolean | null;
  hardwareChannel?: number | null;
  baudRate?: number | null;
  port?: number | null;
  encryptionCapable?: boolean | null;
  optimalPort?: string | null;
  bmcChannelMapping?: string | null;
  resolvedPort?: string | null;
  resolvedBaud?: number | null;
  resolvedSource?: SolResolvedSource | null;
  resolvedConfirmed?: boolean | null;
  availablePorts?: string[];
}

export interface CollectorHandler<TInput = unknown> {
  name: CollectorNameV2;
  schema: ZodType<TInput>;
  handle(input: TInput, ctx: CollectorContext): Promise<DeviceMutation>;
}
