import { type DhcpMode, type IpxeBuildTarget, type PrefixDhcpConfig, PrefixDhcpConfigSchema } from '@repo/api-client';
import { Prisma, type PrismaClient } from '@repo/database';
import { mergeProxyAllowlist } from '@repo/utils';

export type BootQueryClient = Pick<PrismaClient, '$queryRaw'>;

/** The DHCP-config columns on Prefix — single source so adding a column is a one-place edit. */
export const DHCP_CONFIG_COLUMNS = Prisma.sql`p."dhcpMode", p."dhcpLeaseTtlSeconds", p."ipxeBuildTarget", p."dhcpOptions", p."dhcpProxyAllowedMacs", p."dhcpProxyPeerAuthoritative", host(p."dhcpRelayAgentIp") AS "dhcpRelayAgentIp"`;

export interface DhcpConfigRow {
  dhcpMode: DhcpMode | null;
  dhcpLeaseTtlSeconds: number | null;
  ipxeBuildTarget: IpxeBuildTarget;
  dhcpOptions: unknown;
  dhcpProxyAllowedMacs: string[];
  dhcpProxyPeerAuthoritative: boolean;
  dhcpRelayAgentIp: string | null;
}

export function toDhcpConfig(row: DhcpConfigRow): PrefixDhcpConfig {
  const rawOptions = Array.isArray(row.dhcpOptions) ? row.dhcpOptions : [];
  // Fail-closes an out-of-band (direct-SQL) oversized dhcpOptions row that writes already cap.
  const parsed = PrefixDhcpConfigSchema.shape.dhcpOptions.safeParse(rawOptions);
  if (!parsed.success) {
    throw new Error(`Malformed dhcpOptions stored for prefix: ${parsed.error.message}`);
  }
  return {
    dhcpMode: row.dhcpMode,
    dhcpLeaseTtlSeconds: row.dhcpLeaseTtlSeconds,
    ipxeBuildTarget: row.ipxeBuildTarget,
    dhcpOptions: parsed.data,
    dhcpProxyAllowedMacs: row.dhcpProxyAllowedMacs ?? [],
    dhcpProxyPeerAuthoritative: row.dhcpProxyPeerAuthoritative,
    dhcpRelayAgentIp: row.dhcpRelayAgentIp,
  };
}

/** The devices a machine's PXE MAC and BMC address each resolve to; null where no device claims one. */
export interface BootIdentity {
  pxeDeviceId: string | null;
  bmcDeviceId: string | null;
}

export interface BootPrefixSelection {
  id: string;
  selection: 'containing' | 'primary';
}

// the hub passes its tenant and the admin reads hub-wide, so an absent organization adds no predicate
function organizationFence(column: string, organizationId: string | undefined): Prisma.Sql {
  return organizationId === undefined ? Prisma.empty : Prisma.sql`AND ${Prisma.raw(column)} = ${organizationId}`;
}

export async function readDhcpConfig(
  client: BootQueryClient,
  { prefixId, organizationId }: { prefixId: string; organizationId?: string },
): Promise<PrefixDhcpConfig | null> {
  const rows = await client.$queryRaw<DhcpConfigRow[]>`
    SELECT ${DHCP_CONFIG_COLUMNS}
    FROM "Prefix" p
    WHERE p.id = ${prefixId}
      ${organizationFence('p."organizationId"', organizationId)}
      AND p."deletedAt" IS NULL
    LIMIT 1
  `;
  const row = rows[0];
  return row === undefined ? null : toDhcpConfig(row);
}

interface ProxyAllowlistRow {
  operator: string[] | null;
  reserved: string[] | null;
}

/** What the bridge enforces in PROXY mode: the operator column plus every MAC with a reserved IPv4 inside the prefix. */
export async function readProxyAllowlist(
  client: BootQueryClient,
  { prefixId, organizationId }: { prefixId: string; organizationId?: string },
): Promise<string[]> {
  const rows = await client.$queryRaw<ProxyAllowlistRow[]>`
    SELECT
      p."dhcpProxyAllowedMacs" AS operator,
      (
        SELECT array_agg(lower(iface."macAddress"))
        FROM "IpAddress" ip
        JOIN "Interface" iface
          ON iface.id = ip."interfaceId"
          AND iface."deletedAt" IS NULL
          AND iface."macAddress" IS NOT NULL
          AND iface."macAddress" <> '00:00:00:00:00:00'
        WHERE ip.address <<= p.prefix
          AND ip."organizationId" = p."organizationId"
          AND ip."vrfId" IS NOT DISTINCT FROM p."vrfId"
          AND ip."deletedAt" IS NULL
          AND ip.status = 'ACTIVE'
          AND family(ip.address) = 4
      ) AS reserved
    FROM "Prefix" p
    WHERE p.id = ${prefixId}
      ${organizationFence('p."organizationId"', organizationId)}
      AND p."deletedAt" IS NULL
    LIMIT 1
  `;
  const row = rows[0];
  if (row === undefined) return [];
  return mergeProxyAllowlist(row.operator ?? [], row.reserved ?? []).macs;
}

// Deliberately hub-wide, not prefix-scoped: a machine's BMC normally sits on a different prefix
// from the one it PXE-boots on, so scoping either half would report every wiring as split.
export async function resolveBootIdentity(
  client: BootQueryClient,
  { mac, bmcAddress, organizationId }: { mac: string; bmcAddress: string; organizationId?: string },
): Promise<BootIdentity> {
  const rows = await client.$queryRaw<BootIdentity[]>`
    SELECT
      (
        SELECT i."deviceId"
        FROM "Interface" i
        JOIN "Device" d ON d.id = i."deviceId"
        WHERE lower(i."macAddress") = ${mac}
          AND i."deletedAt" IS NULL
          AND d."deletedAt" IS NULL
          ${organizationFence('d."supplierId"', organizationId)}
        ORDER BY d."createdAt" DESC
        LIMIT 1
      ) AS "pxeDeviceId",
      (
        SELECT i."deviceId"
        FROM "IpAddress" ip
        JOIN "Interface" i ON i.id = ip."interfaceId"
        JOIN "Device" d ON d.id = i."deviceId"
        WHERE ip.address = ${bmcAddress}::inet
          AND ip."deletedAt" IS NULL
          ${organizationFence('ip."organizationId"', organizationId)}
          AND i."deletedAt" IS NULL
          AND d."deletedAt" IS NULL
          ${organizationFence('d."supplierId"', organizationId)}
        ORDER BY d."createdAt" DESC
        LIMIT 1
      ) AS "bmcDeviceId"
  `;
  return rows[0] ?? { pxeDeviceId: null, bmcDeviceId: null };
}

/** The prefix a machine PXE-boots on: the narrowest prefix in its zone that contains its data IPv4, else the zone's PRIMARY prefix. */
export async function findBootPrefixForDevice(
  client: BootQueryClient,
  { deviceId, zoneId, organizationId }: { deviceId: string; zoneId: string; organizationId?: string },
): Promise<BootPrefixSelection | null> {
  const containing = await client.$queryRaw<Array<{ id: string }>>`
    SELECT p.id
    FROM "Prefix" p
    JOIN "Interface" i ON i."deviceId" = ${deviceId} AND i."deletedAt" IS NULL AND i."mgmtOnly" = false
    JOIN "IpAddress" ip ON ip."interfaceId" = i.id AND ip."deletedAt" IS NULL AND family(ip.address) = 4
    WHERE p."deletedAt" IS NULL
      ${organizationFence('p."organizationId"', organizationId)}
      AND p."zoneId" = ${zoneId}
      AND p.prefix >>= ip.address
    ORDER BY masklen(p.prefix) DESC
    LIMIT 1
  `;
  const contained = containing[0];
  if (contained) return { id: contained.id, selection: 'containing' };

  const primary = await client.$queryRaw<Array<{ id: string }>>`
    SELECT p.id
    FROM "Prefix" p
    WHERE p."deletedAt" IS NULL
      ${organizationFence('p."organizationId"', organizationId)}
      AND p."zoneId" = ${zoneId}
      AND p.role = 'PRIMARY'::"IpamRole"
    ORDER BY p."createdAt" ASC
    LIMIT 1
  `;
  const first = primary[0];
  return first ? { id: first.id, selection: 'primary' } : null;
}
