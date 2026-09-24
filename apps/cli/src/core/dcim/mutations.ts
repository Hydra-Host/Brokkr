import { OperatingSystemSlugSchema } from '@repo/api-client';
import { ContractType } from '@repo/utils';
import type { CliApiClient } from '../client.js';
import type { DiskLayout } from '../deployments/deployments.js';

export type { DiskLayout };

export interface DeviceActionResult {
  success: boolean;
}

export interface DeviceListingResult {
  id: string;
  name: string;
  nickname: string | null;
  ecoMode: boolean;
  status: string;
  listing: {
    isActive: boolean | null;
    isInterruptibleOnly: boolean | null;
    onDemandPricePerHour: number | null;
    interruptiblePricePerHour: number | null;
  };
}

export async function decommissionServer(client: CliApiClient, deviceId: string): Promise<DeviceActionResult> {
  const result = await client.decommissionServer({ params: { deviceId }, body: {} });
  if (result.status !== 200) {
    throw new Error(`Failed to decommission server (${result.status})`);
  }
  return { success: result.body.success };
}

export async function updateServerSettings(
  client: CliApiClient,
  deviceId: string,
  body: { nickname?: string; ecoMode?: boolean },
): Promise<DeviceActionResult> {
  const result = await client.updateServerInfo({ params: { deviceId }, body });
  if (result.status !== 200) {
    throw new Error(`Failed to update server settings (${result.status})`);
  }
  return { success: result.body.success };
}

export async function updateServerListing(
  client: CliApiClient,
  deviceId: string,
  body: {
    hourlyPrice: number;
    floorHourlyPrice?: number;
    billingFrequency: 'Weekly';
    isListed: boolean;
    isInterruptibleOnly?: boolean;
  },
): Promise<DeviceListingResult> {
  const result = await client.updateServerListing({ params: { deviceId }, body });
  if (result.status !== 200) {
    throw new Error(`Failed to update server listing (${result.status})`);
  }
  const d = result.body;
  return {
    id: d.id,
    name: d.name,
    nickname: d.dcim?.nickname ?? null,
    ecoMode: d.ecoMode ?? false,
    status: d.status?.label ?? 'Unknown',
    listing: {
      isActive: d.listing?.isActive ?? null,
      isInterruptibleOnly: d.listing?.isInterruptibleOnly ?? null,
      onDemandPricePerHour: d.listing?.onDemandPrice?.perHour?.total ?? null,
      interruptiblePricePerHour: d.listing?.interruptiblePrice?.perHour?.total ?? null,
    },
  };
}

export async function provisionServer(
  client: CliApiClient,
  deviceId: string,
  body: {
    deploymentName: string;
    operatingSystem: string;
    sshKeyIds: string[];
    diskLayouts: DiskLayout[];
    cloudInit?: string | Record<string, unknown> | null;
    ipxeUrl?: string;
    projectId?: string;
    contractType?: string;
    customizations?: Record<string, string | string[]> | null;
  },
): Promise<DeviceActionResult> {
  const result = await client.provisionBaremetalServer({
    params: { deviceId },
    body: {
      deploymentName: body.deploymentName,
      operatingSystem: OperatingSystemSlugSchema.parse(body.operatingSystem),
      sshKeyIds: body.sshKeyIds,
      diskLayouts: body.diskLayouts.map((dl) => ({
        ...dl,
        encrypt: dl.encrypt ?? false,
        wipe: dl.wipe ?? true,
      })),
      cloudInit: body.cloudInit ?? null,
      ipxeUrl: body.ipxeUrl ?? null,
      projectId: body.projectId,
      contractType: ContractType.RESERVED_ROLLING,
      isInterruptible: false,
      customizations: body.customizations ?? null,
    },
  });
  if (result.status !== 200) {
    throw new Error(`Failed to provision server (${result.status})`);
  }
  return { success: result.body.success };
}
