// Spoke-written boot markers keyed by the canonical PXE MAC; segments mirror apps/bridge/src/common/redis/redis-keys.ts
export const deviceRedisKeys = {
  dhcpPxeDecision: (zoneId: string, mac: string): string => `${zoneId}:dhcp:pxe:${mac}`,
  ipxeChainHit: (zoneId: string, mac: string): string => `${zoneId}:ipxe:chain:${mac}`,
  discoveryPendingFor: (zoneId: string, mac: string): string => `${zoneId}:discovery:pending:${mac}`,
  // The bridge's own health snapshot (plain JSON, 600 s TTL on the spoke side)
  deviceHealthSnapshot: (zoneId: string, deviceId: string): string => `${zoneId}:device-health:${deviceId}`,
};
