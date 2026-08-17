import type { PaginationMeta } from '../../ui/table.js';
import type { CliApiClient } from '../client.js';

export interface BridgeListItem {
  id: string;
  name: string;
  status: string;
  type: string;
  datacenterName: string;
  zoneName: string;
  interfaceCount: number;
}

export async function listBridges(
  client: CliApiClient,
  query: { page: number; pageSize: number; sort?: string; search?: string; filters?: string },
): Promise<{ data: BridgeListItem[]; meta: PaginationMeta }> {
  const result = await client.getBridges({ query });

  if (result.status !== 200) {
    throw new Error(`Failed to list bridges (${result.status})`);
  }

  const data = result.body.data.map((bridge) => ({
    id: bridge.id,
    name: bridge.name,
    status: bridge.status,
    type: bridge.type,
    datacenterName: bridge.datacenter.name,
    zoneName: bridge.zone.name,
    interfaceCount: bridge.interfaces.length,
  }));

  return { data, meta: result.body.meta };
}

export interface BridgeDetail {
  id: string;
  name: string;
  status: string;
  type: string;
  datacenter: { id: string; name: string };
  zone: { id: string; name: string };
  interfaces: Array<{
    name: string;
    mac_address: string;
    ip_addresses: Array<{ address: string }>;
    enabled: boolean;
    mgmt_only: boolean;
    mark_connected: boolean;
  }>;
}

export async function getBridge(client: CliApiClient, bridgeId: string): Promise<BridgeDetail> {
  const result = await client.getBridgeById({ params: { bridgeId } });

  if (result.status === 404) {
    throw new Error(`Bridge ${bridgeId} not found`);
  }
  if (result.status !== 200) {
    throw new Error(`Failed to get bridge (${result.status})`);
  }

  return result.body;
}
