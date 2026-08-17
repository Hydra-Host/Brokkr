import { DeviceRole } from '@repo/database';

export const SERVER_ROLES: ReadonlySet<DeviceRole> = new Set([
  DeviceRole.Baremetal,
  DeviceRole.Hypervisor,
  DeviceRole.Cluster,
  DeviceRole.DiscoveredHost,
  DeviceRole.OffMarketplaceHost,
  DeviceRole.Decommissioned,
  DeviceRole.Server,
]);

export function roleGetsServer(role: DeviceRole | null): boolean {
  if (role === null) return false;
  return SERVER_ROLES.has(role);
}
