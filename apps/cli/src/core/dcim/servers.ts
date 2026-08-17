import type { BaseLayer, CustomizationLayer } from '@repo/api-client';
import type { PaginationMeta } from '../../ui/table.js';
import type { CliApiClient } from '../client.js';
import type { DiskLayout } from '../deployments/deployments.js';
import { coerceDefaultDiskLayouts } from '../deployments/schemas.js';

export interface ServerListItem {
  id: string;
  name: string;
  ipv4: string | null;
  ipv6: string | null;
  gpuCount: number | null;
  gpuModel: string | null;
  cpuModel: string | null;
  isListed: boolean | null;
  isInterruptibleOnly: boolean | null;
  pricePerHourCents: number | null;
  isHealthy: boolean | null;
  status: string;
  datacenter: string;
}

export interface ServerDetail {
  id: string;
  name: string;
  displayName: string;
  status: string;
  powerStatus: string;
  isHealthy: boolean | null;
  ecoMode: boolean;
  isTeeCapable: boolean;
  datacenter: string;
  tenant: string;
  gpu: { model: string | null; count: number | null };
  cpu: {
    model: string | null;
    count: number | null;
    totalCores: number | null;
    totalThreads: number | null;
  };
  memory: { total: number | null };
  storage: {
    nvmeCount: number | null;
    nvmeSize: number | null;
    ssdCount: number | null;
    ssdSize: number | null;
    hddCount: number | null;
    hddSize: number | null;
    total: number | null;
  };
  networking: {
    ipv4: string | null;
    ipv6: string | null;
    mac: string | null;
    ipmiIp: string | null;
    vpcCapable: boolean | null;
  };
  listing: {
    isActive: boolean | null;
    isInterruptibleOnly: boolean | null;
    isPrivate: boolean | null;
    onDemandPricePerHourCents: number | null;
    interruptiblePricePerHourCents: number | null;
  };
  deployment: {
    deployerEmail: string | null;
    billingFrequency: string | null;
    pricePerHourCents: number | null;
  } | null;
  availableBaseLayers: BaseLayer[];
  availableComponentLayersByBase: Record<string, CustomizationLayer[]>;
  defaultDiskLayouts: DiskLayout[];
}

export async function listServers(
  client: CliApiClient,
  query: {
    page: number;
    pageSize: number;
    sort?: string;
    search?: string;
    role?: string;
    status?: string;
    filters?: string;
  },
): Promise<{ data: ServerListItem[]; meta: PaginationMeta }> {
  const result = await client.getServers({
    query: {
      page: query.page,
      pageSize: query.pageSize,
      role: query.role ?? 'Baremetal',
      ...(query.status ? { status: query.status } : {}),
      ...(query.sort ? { sort: query.sort } : {}),
      ...(query.search ? { search: query.search } : {}),
      ...(query.filters ? { filters: query.filters } : {}),
    },
  });

  if (result.status !== 200) {
    throw new Error(`Failed to list servers (${result.status})`);
  }

  const data = result.body.data.map((server) => ({
    id: server.id,
    name: server.name,
    ipv4: server.networking?.ipv4 ?? null,
    ipv6: server.networking?.ipv6 ?? null,
    gpuCount: server.specs?.gpu?.count ?? null,
    gpuModel: server.specs?.gpu?.model ?? null,
    cpuModel: server.specs?.cpu?.model ?? null,
    isListed: server.listing?.isActive ?? null,
    isInterruptibleOnly: server.listing?.isInterruptibleOnly ?? null,
    pricePerHourCents: server.listing?.onDemandPrice?.perHour?.total ?? null,
    isHealthy: server.isHealthy ?? null,
    status: server.status?.label ?? 'Unknown',
    datacenter: server.zoneName ?? '',
  }));

  return { data, meta: result.body.meta };
}

export async function getServer(client: CliApiClient, deviceId: string): Promise<ServerDetail> {
  const result = await client.getServerById({ params: { deviceId } });

  if (result.status === 404) {
    throw new Error(`Device not found: ${deviceId}`);
  }

  if (result.status !== 200) {
    throw new Error(`Failed to get server (${result.status})`);
  }

  const d = result.body;
  return {
    id: d.id,
    name: d.name,
    displayName: d.dcim?.nickname || d.name,
    status: d.status?.label ?? 'Unknown',
    powerStatus: d.powerStatus?.label ?? 'Unknown',
    isHealthy: d.isHealthy ?? null,
    ecoMode: d.ecoMode ?? false,
    isTeeCapable: d.isTeeCapable ?? false,
    datacenter: d.zoneName ?? '—',
    tenant: d.tenant?.name ?? '—',
    gpu: {
      model: d.specs?.gpu?.model ?? null,
      count: d.specs?.gpu?.count ?? null,
    },
    cpu: {
      model: d.specs?.cpu?.model ?? null,
      count: d.specs?.cpu?.count ?? null,
      totalCores: d.specs?.cpu?.totalCores ?? null,
      totalThreads: d.specs?.cpu?.totalThreads ?? null,
    },
    memory: { total: d.specs?.memory?.total ?? null },
    storage: {
      nvmeCount: d.specs?.storage?.nvmeCount ?? null,
      nvmeSize: d.specs?.storage?.nvmeSize ?? null,
      ssdCount: d.specs?.storage?.ssdCount ?? null,
      ssdSize: d.specs?.storage?.ssdSize ?? null,
      hddCount: d.specs?.storage?.hddCount ?? null,
      hddSize: d.specs?.storage?.hddSize ?? null,
      total: d.specs?.storage?.total ?? null,
    },
    networking: {
      ipv4: d.networking?.ipv4 ?? null,
      ipv6: d.networking?.ipv6 ?? null,
      mac: d.networking?.mac ?? null,
      ipmiIp: d.networking?.ipmiIp ?? null,
      vpcCapable: d.networking?.vpcCapable ?? null,
    },
    listing: {
      isActive: d.listing?.isActive ?? null,
      isInterruptibleOnly: d.listing?.isInterruptibleOnly ?? null,
      isPrivate: d.listing?.isPrivate ?? null,
      onDemandPricePerHourCents: d.listing?.onDemandPrice?.perHour?.total ?? null,
      interruptiblePricePerHourCents: d.listing?.interruptiblePrice?.perHour?.total ?? null,
    },
    deployment: d.deployment
      ? {
          deployerEmail: d.deployment.deployerEmail ?? null,
          billingFrequency: d.deployment.reservation?.billingFrequency ?? null,
          pricePerHourCents: d.deployment.reservation?.pricePerDeviceHour ?? null,
        }
      : null,
    availableBaseLayers: d.availableBaseLayers ?? [],
    availableComponentLayersByBase: d.availableComponentLayersByBase ?? {},
    defaultDiskLayouts: coerceDefaultDiskLayouts(d.defaultDiskLayouts ?? []),
  };
}
