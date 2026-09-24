import { OperatingSystemSlugSchema, type BaseLayer, type CustomizationLayer } from '@repo/api-client';
import { ContractType } from '@repo/utils';
import type { PaginationMeta } from '../../ui/table.js';
import type { CliApiClient } from '../client.js';
import { toDiskFormat, type DiskFormat } from '../deployments/schemas.js';

export interface InventoryListItem {
  id: string;
  name: string;
  location: string | null;
  stockStatus: string;
  cpuModel: string | null;
  gpuModel: string | null;
  gpuCount: number | null;
  memoryGb: number | null;
  storageGb: number | null;
  pricePerHourCents: number | null;
  isInterruptibleOnly: boolean;
}

export interface InventoryDiskLayout {
  config: string;
  format: DiskFormat;
  mountpoint: string;
  diskType: string;
  disks: string[];
}

export interface InventoryDetail {
  id: string;
  name: string;
  location: string | null;
  stockStatus: string;
  isInterruptibleOnly: boolean;
  cpu: {
    model: string | null;
    count: number | null;
    totalCores: number | null;
    totalThreads: number | null;
  };
  gpu: {
    model: string | null;
    count: number | null;
  };
  memory: { totalGb: number | null };
  storage: {
    nvmeCount: number | null;
    nvmeSizeGb: number | null;
    ssdCount: number | null;
    ssdSizeGb: number | null;
    hddCount: number | null;
    hddSizeGb: number | null;
    totalGb: number | null;
  };
  networking: {
    ipv4: string | null;
    ipv6: string | null;
    networkType: string;
    vpcCapable: boolean;
  };
  pricing: {
    onDemandPerHourCents: number | null;
    onDemandPerWeekCents: number | null;
    onDemandPerMonthCents: number | null;
    interruptiblePerHourCents: number | null;
  };
  availableBaseLayers: BaseLayer[];
  availableComponentLayersByBase: Record<string, CustomizationLayer[]>;
  defaultDiskLayouts: InventoryDiskLayout[];
  availableAt: string;
}

export async function listInventory(
  client: CliApiClient,
  query: { page: number; pageSize: number; sort?: string; search?: string; filters?: string },
): Promise<{ data: InventoryListItem[]; meta: PaginationMeta }> {
  const result = await client.getInventory({
    query: {
      page: query.page,
      pageSize: query.pageSize,
      ...(query.filters ? { filters: query.filters } : {}),
    },
  });

  if (result.status !== 200) {
    throw new Error(`Failed to list inventory (${result.status})`);
  }

  const data = result.body.data.map((item) => ({
    id: item.id,
    name: item.name,
    location: item.location ?? null,
    stockStatus: item.stockStatus,
    cpuModel: item.specs?.cpu?.model ?? null,
    gpuModel: item.specs?.gpu?.model ?? null,
    gpuCount: item.specs?.gpu?.count ?? null,
    memoryGb: item.specs?.memory?.total ?? null,
    storageGb: item.specs?.storage?.total ?? null,
    pricePerHourCents: item.listing?.onDemandPrice?.perHour?.total ?? null,
    isInterruptibleOnly: item.listing?.isInterruptibleOnly ?? false,
  }));

  return { data, meta: result.body.meta };
}

export async function getInventoryItem(client: CliApiClient, id: string): Promise<InventoryDetail> {
  const result = await client.getInventoryById({ params: { id } });

  if (result.status !== 200) {
    if (result.status === 404) {
      throw new Error(`Inventory item not found: ${id}`);
    }
    throw new Error(`Failed to get inventory item`);
  }

  const d = result.body;
  return {
    id: d.id,
    name: d.name,
    location: d.location ?? null,
    stockStatus: d.stockStatus,
    isInterruptibleOnly: d.listing?.isInterruptibleOnly ?? false,
    cpu: {
      model: d.specs?.cpu?.model ?? null,
      count: d.specs?.cpu?.count ?? null,
      totalCores: d.specs?.cpu?.totalCores ?? null,
      totalThreads: d.specs?.cpu?.totalThreads ?? null,
    },
    gpu: {
      model: d.specs?.gpu?.model ?? null,
      count: d.specs?.gpu?.count ?? null,
    },
    memory: { totalGb: d.specs?.memory?.total ?? null },
    storage: {
      nvmeCount: d.specs?.storage?.nvmeCount ?? null,
      nvmeSizeGb: d.specs?.storage?.nvmeSize ?? null,
      ssdCount: d.specs?.storage?.ssdCount ?? null,
      ssdSizeGb: d.specs?.storage?.ssdSize ?? null,
      hddCount: d.specs?.storage?.hddCount ?? null,
      hddSizeGb: d.specs?.storage?.hddSize ?? null,
      totalGb: d.specs?.storage?.total ?? null,
    },
    networking: {
      ipv4: d.networking?.ipv4 ?? null,
      ipv6: d.networking?.ipv6 ?? null,
      networkType: d.networking?.networkType ?? '—',
      vpcCapable: d.networking?.vpcCapable ?? false,
    },
    pricing: {
      onDemandPerHourCents: d.listing?.onDemandPrice?.perHour?.total ?? null,
      onDemandPerWeekCents: d.listing?.onDemandPrice?.perWeek?.total ?? null,
      onDemandPerMonthCents: d.listing?.onDemandPrice?.perMonth?.total ?? null,
      interruptiblePerHourCents: d.listing?.interruptiblePrice?.perHour?.total ?? null,
    },
    availableBaseLayers: d.availableBaseLayers ?? [],
    availableComponentLayersByBase: d.availableComponentLayersByBase ?? {},
    defaultDiskLayouts: (d.defaultDiskLayouts ?? []).map((dl) => ({
      config: dl.config,
      format: toDiskFormat(dl.format),
      mountpoint: dl.mountpoint,
      diskType: dl.diskType,
      disks: dl.disks,
    })),
    availableAt: d.availableAt,
  };
}

export interface RentInventoryDeviceInput {
  deploymentName: string;
  operatingSystem: string;
  sshKeyIds: string[];
  projectId?: string;
  diskLayouts: InventoryDiskLayout[];
  cloudInit?: string | null;
  ipxeUrl?: string | null;
  customizations?: Record<string, string | string[]> | null;
}

export async function rentInventoryDevice(
  client: CliApiClient,
  id: string,
  input: RentInventoryDeviceInput,
): Promise<{ success: boolean }> {
  const result = await client.provisionDevice({
    params: { id },
    body: {
      contractType: ContractType.RESERVED_ROLLING,
      isInterruptible: false,
      deploymentName: input.deploymentName,
      operatingSystem: OperatingSystemSlugSchema.parse(input.operatingSystem),
      sshKeyIds: input.sshKeyIds,
      projectId: input.projectId,
      diskLayouts: input.diskLayouts.map((dl) => ({ ...dl, encrypt: false, wipe: true })),
      cloudInit: input.cloudInit ?? null,
      ipxeUrl: input.ipxeUrl ?? null,
      customizations: input.customizations ?? null,
    },
  });

  if (result.status !== 200) {
    if (result.status === 400) {
      throw new Error(result.body.message ?? 'Invalid request');
    }
    if (result.status === 404) {
      throw new Error(`Inventory item not found: ${id}`);
    }
    throw new Error(`Failed to rent device`);
  }

  return { success: result.body.success };
}
