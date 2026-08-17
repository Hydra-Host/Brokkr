import type { Interface } from '@repo/api-client';

export interface DeviceInterfaceRow {
  name: string;
  type: string | null;
  macAddress: string | null;
  markConnected: boolean;
  enabled: boolean;
  mgmtOnly: boolean;
  ipAddresses: Array<{ id: string; address: string }>;
}

export function toInterfaceResponse(iface: DeviceInterfaceRow): Interface {
  return {
    name: iface.name,
    type: iface.type,
    mac_address: iface.macAddress ?? '',
    // Load-bearing projection: callers pass full IpAddress rows at runtime — a direct assignment
    // would leak organizationId/vrfId/etc. into the response (ts-rest doesn't validate responses).
    ip_addresses: iface.ipAddresses.map((ip) => ({ id: ip.id, address: ip.address })),
    mark_connected: iface.markConnected,
    enabled: iface.enabled,
    mgmt_only: iface.mgmtOnly,
  };
}
