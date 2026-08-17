import type { Prisma } from '@repo/database';

export const DNS_ZONE_BASE_SELECT = {
  dnsEnabled: true,
  dnsUpstreamResolvers: true,
  dnsTtlSeconds: true,
  dnsCacheSize: true,
  dnsOwnedDomain: true,
  dnsUpstreamTimeoutMs: true,
  dnsPollMs: true,
  dnsTcpMaxConnections: true,
  dnsTcpMaxQueriesPerConn: true,
  dnsTcpIdleTimeoutMs: true,
  dnsTcpMaxMessageBytes: true,
  dnsMaxTtlSeconds: true,
  dnsMaxCacheTtlSeconds: true,
  dnsMinCacheTtlSeconds: true,
  dnsNegTtlSeconds: true,
} as const satisfies Prisma.ZoneSelect;

export type DnsZoneBaseRow = Prisma.ZoneGetPayload<{ select: typeof DNS_ZONE_BASE_SELECT }>;
