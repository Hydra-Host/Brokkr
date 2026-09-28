import { isIPv4 } from 'node:net';

import { Injectable } from '@nestjs/common';
import { DhcpRelayAgentIpSchema, DhcpReservationSchema, type DhcpReservation } from '@repo/api-client';
import { Prisma } from '@repo/database';
import { mergeProxyAllowlist } from '@repo/utils';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import {
  BOOT_FILENAME_RE,
  DhcpAtomSchema,
  DhcpZoneOpsAtomSchema,
  type DhcpAtom,
  type DhcpZoneOpsAtom,
} from './dhcp-atom.schema';

const DEFAULT_LEASE_TTL_SECONDS = 600;

// Canonical 6-octet lowercase colon MAC, matching DhcpAtomSchema's reservation mac.
const CANONICAL_MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;

/** Raw DB row from the cross-tenant DHCP prefix query. */
interface DhcpPrefixRow {
  prefixId: string;
  zoneId: string;
  prefix: string;
  dhcpMode: string;
  dhcpLeaseTtlSeconds: number | null;
  dhcpOptions: unknown;
  dhcpProxyAllowedMacs: string[] | null;
  dhcpProxyPeerAuthoritative: boolean;
  ipxeBuildTarget: string | null;
  role: string | null;
  gatewayIp: string | null;
  dhcpRelayAgentIp: string | null;
  associatedPrefixId: string | null;
}

interface PoolRow {
  prefixId: string;
  start: string;
  end: string;
}

interface ReservationRow {
  prefixId: string;
  mac: string;
  ip: string;
  // Per-device iPXE build override (Server.ipxeBuildTarget). Null when the device has no
  // override — the reservation then inherits the prefix-level ipxeBuildTarget.
  ipxeBuildTarget: string | null;
  bootFilename: string | null;
  // Read-side extras (not used by the atom builder): the device name as the reservation hostname,
  // plus the owning device/interface UUIDs so the zone-DHCP UI can link through to management.
  hostname: string | null;
  deviceId: string;
  interfaceId: string;
}

// 'disabled' is safe to clear; 'error' must NOT clear — that would delete a live atom on a
// transient failure.
export type DeriveOneResult =
  | { status: 'enabled'; zoneId: string; atom: DhcpAtom }
  | { status: 'disabled' }
  | { status: 'error' };

// enabledKeys includes prefixes whose derivation threw: a key here but absent from atoms means
// "failed this tick" — the reconciler must preserve that live atom, never clear it.
export interface DeriveAllResult {
  atoms: Array<{ prefixId: string; zoneId: string; atom: DhcpAtom }>;
  enabledKeys: Set<string>;
}

export type DeriveZoneOpsResult =
  | { status: 'ok'; atom: DhcpZoneOpsAtom }
  | { status: 'not_found' }
  | { status: 'error' };

export interface DeriveAllZoneOpsResult {
  atoms: Array<{ zoneId: string; atom: DhcpZoneOpsAtom }>;
  liveZoneIds: Set<string>;
  queryFailed: boolean;
}

// Cross-tenant (no request context) — called from the background reconcile cron.
@Injectable()
export class DhcpDerivationService {
  constructor(
    private readonly prisma: PrismaClient,
    @Logger(DhcpDerivationService.name) private readonly logger: LoggerService,
  ) {}

  async deriveAll(): Promise<DeriveAllResult> {
    const prefixes = await this.listDhcpEnabledPrefixes();
    const enabledKeys = new Set(prefixes.map((p) => `${p.zoneId}:${p.prefixId}`));
    if (prefixes.length === 0) return { atoms: [], enabledKeys };

    const prefixIds = prefixes.map((p) => p.prefixId);
    // On batch-load failure degrade to zero atoms + full enabledKeys: the reconciler then clears
    // nothing and retries next tick. A PARTIAL result would risk clearing healthy atoms.
    const loaded = await Promise.all([
      this.loadPools(prefixIds),
      this.loadReservations(prefixIds),
      this.loadRelayBridgeIps(prefixes),
    ]).catch((error: unknown) => {
      this.logger.error(
        `DHCP deriveAll: batch pool/reservation/relay load failed, preserving current atoms this tick: ${getErrorMessage(error)}`,
      );
      return null;
    });
    if (loaded === null) return { atoms: [], enabledKeys };
    const [poolsByPrefix, reservationsByPrefix, relayIpsByPrefix] = loaded;

    const atoms: Array<{ prefixId: string; zoneId: string; atom: DhcpAtom }> = [];

    for (const row of prefixes) {
      try {
        const atom = this.buildAtom(
          row,
          poolsByPrefix.get(row.prefixId) ?? [],
          reservationsByPrefix.get(row.prefixId) ?? [],
          relayIpsByPrefix.get(row.prefixId) ?? [],
        );
        atoms.push({ prefixId: row.prefixId, zoneId: row.zoneId, atom });
      } catch (error) {
        this.logger.error(
          `Failed to derive DHCP atom for prefix ${row.prefixId} (${row.prefix}): ${getErrorMessage(error)}`,
        );
      }
    }

    return { atoms, enabledKeys };
  }

  async deriveOne(prefixId: string): Promise<DeriveOneResult> {
    let rows: DhcpPrefixRow[];
    try {
      rows = await this.listDhcpEnabledPrefixes(prefixId);
    } catch (error) {
      this.logger.error(`Failed to query prefix ${prefixId} for DHCP derivation: ${getErrorMessage(error)}`);
      return { status: 'error' };
    }

    const row = rows[0];
    if (!row) return { status: 'disabled' };

    try {
      const [pools, reservations, relayIps] = await Promise.all([
        this.loadPools([prefixId]),
        this.loadReservations([prefixId]),
        this.loadRelayBridgeIps(rows),
      ]);
      const atom = this.buildAtom(
        row,
        pools.get(prefixId) ?? [],
        reservations.get(prefixId) ?? [],
        relayIps.get(prefixId) ?? [],
      );
      return { status: 'enabled', zoneId: row.zoneId, atom };
    } catch (error) {
      this.logger.error(`Failed to derive DHCP atom for prefix ${prefixId}: ${getErrorMessage(error)}`);
      return { status: 'error' };
    }
  }

  buildAtom(
    row: DhcpPrefixRow,
    pools: PoolRow[],
    reservations: ReservationRow[],
    relayBridgeIps: string[] = [],
  ): DhcpAtom {
    // Here and in every skip below: filter invalid values instead of letting one bad row fail
    // DhcpAtomSchema.parse and freeze the whole prefix's derivation.
    const routers: string[] = [];
    if (row.gatewayIp) {
      if (isIPv4(row.gatewayIp)) {
        routers.push(row.gatewayIp);
      } else {
        this.logger.warn(`DHCP prefix ${row.prefixId}: gateway ${JSON.stringify(row.gatewayIp)} is not IPv4, omitting`);
      }
    }

    let relay: DhcpAtom['relay'] = null;
    if (row.dhcpRelayAgentIp) {
      // Guard with the same schema DhcpAtomSchema.parse applies below — a weaker check (e.g.
      // bare isIPv4) would let a non-routable value through to parse() and freeze derivation.
      if (DhcpRelayAgentIpSchema.safeParse(row.dhcpRelayAgentIp).success) {
        relay = { relayAgentIp: row.dhcpRelayAgentIp };
      } else {
        this.logger.warn(
          `DHCP prefix ${row.prefixId}: relay agent IP ${JSON.stringify(row.dhcpRelayAgentIp)} is not a routable unicast IPv4 address, omitting relay`,
        );
      }
    }

    const dhcpOptions = this.mapDhcpOptions(row.dhcpOptions, row.prefixId);

    // Dedup by MAC (first wins); skip malformed MACs / non-IPv4 IPs instead of throwing, so one bad interface can't freeze the prefix's derivation.
    const seenMacs = new Set<string>();
    const dedupedReservations: Array<{
      mac: string;
      ip: string;
      ipxeBuildTarget?: 'IPXE' | 'SNP' | 'SNPONLY';
      bootFilename?: string;
    }> = [];
    for (const res of reservations) {
      const mac = res.mac.toLowerCase();
      if (!CANONICAL_MAC_RE.test(mac)) {
        this.logger.warn(`DHCP reservation for ${res.ip} skipped: malformed MAC ${JSON.stringify(res.mac)}`);
        continue;
      }
      if (!isIPv4(res.ip)) {
        this.logger.warn(`DHCP reservation for MAC ${mac} skipped: invalid IPv4 ${JSON.stringify(res.ip)}`);
        continue;
      }
      if (seenMacs.has(mac)) continue;
      seenMacs.add(mac);
      // Carry a per-device iPXE override only when the device declares a valid one; otherwise
      // omit the field so the reservation inherits the prefix-level ipxeBuildTarget.
      const t = res.ipxeBuildTarget;
      const reservation: (typeof dedupedReservations)[number] =
        t === 'IPXE' || t === 'SNP' || t === 'SNPONLY' ? { mac, ip: res.ip, ipxeBuildTarget: t } : { mac, ip: res.ip };
      if (res.bootFilename) {
        if (BOOT_FILENAME_RE.test(res.bootFilename)) {
          reservation.bootFilename = res.bootFilename;
        } else {
          this.logger.warn(
            `DHCP reservation for MAC ${mac}: invalid bootFilename ${JSON.stringify(res.bootFilename)}, omitting override`,
          );
        }
      }
      dedupedReservations.push(reservation);
    }

    // Column is NOT NULL DEFAULT 'IPXE'; guard stale raw-query values by falling back to the
    // IPXE default instead of publishing null (null suppresses the bridge's boot file entirely).
    const prefixIpxe = row.ipxeBuildTarget;
    const ipxeBuildTarget = prefixIpxe === 'SNP' || prefixIpxe === 'SNPONLY' ? prefixIpxe : 'IPXE';

    // Fail-closed: non-PROXY modes publish an empty proxyAllowedMacs (empty = deny-all).
    let proxyAllowedMacs: string[] = [];
    if (row.dhcpMode === 'PROXY') {
      const merged = mergeProxyAllowlist(
        row.dhcpProxyAllowedMacs ?? [],
        dedupedReservations.map((r) => r.mac),
      );
      for (const operatorMac of merged.rejected) {
        this.logger.warn(
          `DHCP prefix ${row.prefixId}: operator proxyAllowedMac skipped: malformed MAC ${JSON.stringify(operatorMac)}`,
        );
      }
      proxyAllowedMacs = merged.macs;
    }

    let nextServer: string | null = null;
    let dnsServers: string[] = [];
    if (relay !== null) {
      if (relayBridgeIps.length > 0) {
        dnsServers = relayBridgeIps;
        if (ipxeBuildTarget !== null) {
          nextServer = relayBridgeIps[0];
        }
      } else {
        this.logger.warn(
          row.associatedPrefixId
            ? `DHCP prefix ${row.prefixId}: relayed prefix has no bridge IPs on a DHCP-served associated prefix; clients get no dns or next-server options`
            : `DHCP prefix ${row.prefixId}: relayed prefix has no associated prefix set; clients get no dns or next-server options`,
        );
      }
    }

    const raw = {
      mode: row.dhcpMode,
      subnet: row.prefix,
      pools: pools.map((p) => ({ start: p.start, end: p.end })),
      routers,
      dnsServers,
      // Fall back to the default for null AND any value below the schema floor (DhcpAtomSchema
      // requires min(120)); a stored 1-119 would otherwise fail parse and stall derivation.
      leaseTtlSeconds:
        row.dhcpLeaseTtlSeconds && row.dhcpLeaseTtlSeconds >= 120 ? row.dhcpLeaseTtlSeconds : DEFAULT_LEASE_TTL_SECONDS,
      reservations: dedupedReservations,
      proxyAllowedMacs,
      proxyPeerAuthoritative: row.dhcpProxyPeerAuthoritative,
      dhcpOptions,
      nextServer,
      ipxeBuildTarget,
      relay,
    };

    return DhcpAtomSchema.parse(raw);
  }

  private async listDhcpEnabledPrefixes(prefixId?: string): Promise<DhcpPrefixRow[]> {
    const prefixFilter = prefixId ? Prisma.sql`AND p.id = ${prefixId}` : Prisma.empty;
    return this.prisma.$queryRaw<DhcpPrefixRow[]>`
      SELECT
        p.id AS "prefixId",
        p."zoneId",
        p.prefix::text AS prefix,
        p."dhcpMode",
        p."dhcpLeaseTtlSeconds",
        p."dhcpOptions",
        p."dhcpProxyAllowedMacs",
        p."dhcpProxyPeerAuthoritative",
        p."ipxeBuildTarget",
        p.role,
        host(gw_ip.address) AS "gatewayIp",
        host(p."dhcpRelayAgentIp") AS "dhcpRelayAgentIp",
        p."associatedPrefixId"
      FROM "Prefix" p
      JOIN "Zone" z ON z.id = p."zoneId" AND z."deletedAt" IS NULL
      LEFT JOIN "IpamPrefixVlanRole" pr ON pr.id = p."prefixRoleId"
      LEFT JOIN "IpAddress" gw_ip
        ON gw_ip.id = p."gatewayIpId" AND gw_ip."deletedAt" IS NULL
      WHERE p."dhcpMode" IS NOT NULL
        AND p."dhcpMode" <> 'OFF'
        AND p."zoneId" IS NOT NULL
        AND p."deletedAt" IS NULL
        AND p.role IS DISTINCT FROM 'NAT'
        AND (pr.slug IS NULL OR lower(pr.slug) NOT IN ('nat', 'nat-prefix'))
        AND NOT EXISTS (
          SELECT 1 FROM "TagAssignment" ta
          JOIN "Tag" t ON t.id = ta."tagId"
          WHERE ta."objectType" = 'PREFIX'
            AND ta."objectId" = p.id
            AND lower(t.slug) = 'nat-prefix'
        )
        AND family(p.prefix) = 4
        ${prefixFilter}
    `;
  }

  // Zone filter mirrors the legacy Kea config's location-based range filtering.
  private async loadPools(prefixIds: string[]): Promise<Map<string, PoolRow[]>> {
    if (prefixIds.length === 0) return new Map();

    const rows = await this.prisma.$queryRaw<PoolRow[]>`
      SELECT
        r."prefixId",
        host(r.start) AS start,
        host(r."end") AS "end"
      FROM "IpRange" r
      JOIN "Prefix" p ON p.id = r."prefixId"
      WHERE r."prefixId" = ANY(${prefixIds}::text[])
        AND r."deletedAt" IS NULL
        AND r.status = 'ACTIVE'
        AND p."deletedAt" IS NULL
        AND (r."zoneId" IS NULL OR r."zoneId" = p."zoneId")
        AND family(r.start) = 4
        -- Both bounds must sit inside the prefix CIDR; an out-of-prefix range would poison the
        -- atom's pools and make the bridge drop the subnet on pool validation.
        AND r.start <<= p.prefix
        AND r."end" <<= p.prefix
      ORDER BY r.start
    `;

    return this.groupByPrefixId(rows);
  }

  private async loadReservations(prefixIds: string[], organizationId?: string): Promise<Map<string, ReservationRow[]>> {
    if (prefixIds.length === 0) return new Map();

    // Request-path callers pass the requester's org for defense-in-depth scoping; the cross-tenant reconcile
    // omits it (relies on the per-prefix ip.org = p.org join). Prisma.empty keeps the reconcile SQL byte-identical.
    const orgScope = organizationId ? Prisma.sql`AND p."organizationId" = ${organizationId}` : Prisma.empty;

    const rows = await this.prisma.$queryRaw<ReservationRow[]>(Prisma.sql`
      SELECT
        p.id AS "prefixId",
        lower(iface."macAddress") AS mac,
        host(ip.address) AS ip,
        srv."ipxeBuildTarget" AS "ipxeBuildTarget",
        dev."bootFilename" AS "bootFilename",
        dev.name AS hostname,
        iface."deviceId" AS "deviceId",
        iface.id AS "interfaceId"
      FROM "Prefix" p
      JOIN "IpAddress" ip
        -- <<= (contained-or-equal), not << (strictly-contained): a host IP is often stored WITH its
        -- subnet mask (e.g. 10.0.0.5/24), and << is false when masklen(ip) == masklen(prefix)
        -- (/24 vs /24), so << would silently miss every such interface as a reservation.
        ON ip.address <<= p.prefix
        AND ip."organizationId" = p."organizationId"
        AND ip."vrfId" IS NOT DISTINCT FROM p."vrfId"
        AND ip."deletedAt" IS NULL
        AND ip.status = 'ACTIVE'
      JOIN "Interface" iface
        ON iface.id = ip."interfaceId"
        AND iface."deletedAt" IS NULL
        AND iface."macAddress" IS NOT NULL
        AND iface."macAddress" <> '00:00:00:00:00:00'
      -- LEFT JOIN so a soft-deleted/absent device just yields a null override (inherit
      -- the prefix target) rather than dropping the reservation entirely.
      LEFT JOIN "Device" dev
        ON dev.id = iface."deviceId"
        AND dev."deletedAt" IS NULL
      LEFT JOIN "Server" srv ON srv."deviceId" = dev.id
      WHERE p.id = ANY(${prefixIds}::text[])
        AND p."deletedAt" IS NULL
        ${orgScope}
        AND family(ip.address) = 4
      ORDER BY ip.address
    `);

    return this.groupByPrefixId(rows);
  }

  private async loadRelayBridgeIps(rows: DhcpPrefixRow[]): Promise<Map<string, string[]>> {
    const relayPrefixIds = rows.filter((r) => r.dhcpRelayAgentIp && r.associatedPrefixId).map((r) => r.prefixId);
    if (relayPrefixIds.length === 0) return new Map();

    const ipRows = await this.prisma.$queryRaw<Array<{ prefixId: string; ip: string }>>`
      SELECT "prefixId", ip FROM (
        SELECT DISTINCT ON (p.id, dev.id)
          p.id AS "prefixId",
          host(ip.address) AS ip,
          ip.address AS addr
        FROM "Prefix" p
        JOIN "Prefix" assoc
          ON assoc.id = p."associatedPrefixId"
          AND assoc."deletedAt" IS NULL
          AND assoc."zoneId" = p."zoneId"
          AND assoc."dhcpMode" IS NOT NULL
          AND assoc."dhcpMode" <> 'OFF'
          AND assoc.role IS DISTINCT FROM 'NAT'
        LEFT JOIN "IpamPrefixVlanRole" apr ON apr.id = assoc."prefixRoleId"
        JOIN "IpAddress" ip
          ON ip.address <<= assoc.prefix
          AND ip."organizationId" = assoc."organizationId"
          AND (ip."vrfId" IS NOT DISTINCT FROM assoc."vrfId" OR ip."vrfId" IS NULL)
          AND ip."deletedAt" IS NULL
          AND ip.status = 'ACTIVE'
          AND family(ip.address) = 4
        JOIN "Interface" iface
          ON iface.id = ip."interfaceId"
          AND iface."deletedAt" IS NULL
        JOIN "Device" dev
          ON dev.id = iface."deviceId"
          AND dev."deletedAt" IS NULL
          AND dev."zoneId" = p."zoneId"
        JOIN "Bridge" b
          ON b."deviceId" = dev.id
        WHERE p.id = ANY(${relayPrefixIds}::text[])
          AND (apr.slug IS NULL OR lower(apr.slug) NOT IN ('nat', 'nat-prefix'))
          AND NOT EXISTS (
            SELECT 1 FROM "TagAssignment" ta
            JOIN "Tag" t ON t.id = ta."tagId"
            WHERE ta."objectType" = 'PREFIX'
              AND ta."objectId" = assoc.id
              AND lower(t.slug) = 'nat-prefix'
          )
          AND NOT EXISTS (
            SELECT 1 FROM "Prefix" vp WHERE vp."vrrpVipId" = ip.id AND vp."deletedAt" IS NULL
          )
        ORDER BY p.id, dev.id, ip.address
      ) bridge_ips
      ORDER BY "prefixId", addr
    `;

    const result = new Map<string, string[]>();
    for (const [prefixId, list] of this.groupByPrefixId(ipRows)) {
      result.set(prefixId, [...new Set(list.map((r) => r.ip))]);
    }
    return result;
  }

  // Read-only DHCP reservations for a prefix (same JOIN as loadReservations), surfaced for the zone-DHCP UI
  // with deviceId/interfaceId. Rows failing the contract schema (e.g. a non-48-bit MAC) are dropped, like the atom builder.
  async listReservationsForPrefix(prefixId: string, organizationId?: string): Promise<DhcpReservation[]> {
    const rows = (await this.loadReservations([prefixId], organizationId)).get(prefixId) ?? [];
    const seenMacs = new Set<string>();
    const reservations: DhcpReservation[] = [];
    for (const row of rows) {
      // DhcpReservationSchema is a z.object (strip mode), so the row's extra `prefixId` is dropped.
      const parsed = DhcpReservationSchema.safeParse(row);
      if (!parsed.success) {
        this.logger.warn(
          `Dropping malformed DHCP reservation for prefix ${prefixId} (mac ${JSON.stringify(row.mac)}, ip ${row.ip}): ${parsed.error.message}`,
        );
        continue;
      }
      // Dedupe by MAC (first-by-IP wins — rows are ordered by address), matching buildAtom's
      // reservation dedup so the read view shows exactly the one reservation the bridge serves per MAC.
      if (seenMacs.has(parsed.data.mac)) continue;
      seenMacs.add(parsed.data.mac);
      reservations.push(parsed.data);
    }
    return reservations;
  }

  private groupByPrefixId<T extends { prefixId: string }>(rows: T[]): Map<string, T[]> {
    const grouped = new Map<string, T[]>();
    for (const row of rows) {
      const existing = grouped.get(row.prefixId);
      if (existing) {
        existing.push(row);
      } else {
        grouped.set(row.prefixId, [row]);
      }
    }
    return grouped;
  }

  // Values pass through as raw DHCP_OPTIONS grammar strings; the bridge encodes to bytes via
  // parseDhcpOptionValue at apply time.
  private mapDhcpOptions(raw: unknown, prefixId: string): DhcpAtom['dhcpOptions'] {
    if (raw === null || raw === undefined) return [];
    const parsed = DhcpAtomSchema.shape.dhcpOptions.safeParse(raw);
    if (!parsed.success) {
      this.logger.warn(
        `DHCP prefix ${prefixId}: malformed dhcpOptions in DB, treating as empty: ${parsed.error.message}`,
      );
      return [];
    }
    return parsed.data;
  }

  async deriveAllZoneOps(): Promise<DeriveAllZoneOpsResult> {
    let rows: Array<{ zoneId: string; atom: DhcpZoneOpsAtom }>;
    try {
      rows = await this.listZoneOps();
    } catch (error) {
      this.logger.error(
        `DHCP deriveAllZoneOps: zone query failed, preserving current atoms: ${getErrorMessage(error)}`,
      );
      return { atoms: [], liveZoneIds: new Set(), queryFailed: true };
    }
    return { atoms: rows, liveZoneIds: new Set(rows.map((r) => r.zoneId)), queryFailed: false };
  }

  async deriveOneZoneOps(zoneId: string): Promise<DeriveZoneOpsResult> {
    let rows: Array<{ zoneId: string; atom: DhcpZoneOpsAtom }>;
    try {
      rows = await this.listZoneOps(zoneId);
    } catch (error) {
      this.logger.error(`Failed to query zone ${zoneId} for DHCP ops derivation: ${getErrorMessage(error)}`);
      return { status: 'error' };
    }
    const row = rows[0];
    if (!row) return { status: 'not_found' };
    return { status: 'ok', atom: row.atom };
  }

  private async listZoneOps(zoneId?: string): Promise<Array<{ zoneId: string; atom: DhcpZoneOpsAtom }>> {
    const rows = await this.prisma.zone.findMany({
      where: { deletedAt: null, ...(zoneId ? { id: zoneId } : {}) },
      select: {
        id: true,
        dhcpLeaderPollMs: true,
        dhcpPruneIntervalMs: true,
        dhcpDeclineBackoffSeconds: true,
      },
    });
    return rows.map((r) => ({
      zoneId: r.id,
      atom: DhcpZoneOpsAtomSchema.parse({
        leaderPollMs: Math.max(r.dhcpLeaderPollMs, 1),
        pruneIntervalMs: Math.max(r.dhcpPruneIntervalMs, 1),
        declineBackoffSeconds: Math.max(r.dhcpDeclineBackoffSeconds, 0),
      }),
    }));
  }
}
