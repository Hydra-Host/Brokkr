import { isIPv4 } from 'node:net';

import { Injectable } from '@nestjs/common';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import {
  DnsConfigAtomSchema,
  DnsPrefixOverrideAtomSchema,
  type DnsConfigAtom,
  type DnsPrefixOverrideAtom,
} from './dns-atom.schema';
import { DNS_ZONE_BASE_SELECT, type DnsZoneBaseRow } from './dns-zone-select.constants';

interface ZoneDnsRow extends DnsZoneBaseRow {
  zoneId: string;
  bridgeHostnames: string[];
}

interface PrefixDnsRow {
  prefixId: string;
  zoneId: string;
  dnsServeDns: boolean | null;
  dnsUpstreamOverride: string[];
}

export type DeriveZoneResult =
  | { status: 'ok'; zoneId: string; atom: DnsConfigAtom }
  | { status: 'not_found' }
  | { status: 'error' };

export type DerivePrefixResult =
  | { status: 'ok'; zoneId: string; atom: DnsPrefixOverrideAtom }
  | { status: 'not_found' }
  | { status: 'error' };

export interface DeriveAllZonesResult {
  atoms: Array<{ zoneId: string; atom: DnsConfigAtom }>;
  enabledKeys: Set<string>;
  queryFailed: boolean;
}

export interface DeriveAllPrefixesResult {
  atoms: Array<{ prefixId: string; zoneId: string; atom: DnsPrefixOverrideAtom }>;
  enabledKeys: Set<string>;
  queryFailed: boolean;
}

@Injectable()
export class DnsDerivationService {
  constructor(
    private readonly prisma: PrismaClient,
    @Logger(DnsDerivationService.name) private readonly logger: LoggerService,
  ) {}

  async deriveAllZones(): Promise<DeriveAllZonesResult> {
    let rows: ZoneDnsRow[];
    try {
      rows = await this.listDnsZones();
    } catch (error) {
      this.logger.error(`DNS deriveAllZones: zone query failed, preserving current atoms: ${getErrorMessage(error)}`);
      return { atoms: [], enabledKeys: new Set(), queryFailed: true };
    }

    const enabledKeys = new Set(rows.map((r) => r.zoneId));
    const atoms: Array<{ zoneId: string; atom: DnsConfigAtom }> = [];

    for (const row of rows) {
      try {
        const atom = this.buildZoneAtom(row);
        atoms.push({ zoneId: row.zoneId, atom });
      } catch (error) {
        this.logger.error(`Failed to derive DNS zone atom for zone ${row.zoneId}: ${getErrorMessage(error)}`);
      }
    }

    return { atoms, enabledKeys, queryFailed: false };
  }

  async deriveOneZone(zoneId: string): Promise<DeriveZoneResult> {
    let rows: ZoneDnsRow[];
    try {
      rows = await this.listDnsZones(zoneId);
    } catch (error) {
      this.logger.error(`Failed to query zone ${zoneId} for DNS derivation: ${getErrorMessage(error)}`);
      return { status: 'error' };
    }

    const row = rows[0];
    if (!row) return { status: 'not_found' };

    try {
      const atom = this.buildZoneAtom(row);
      return { status: 'ok', zoneId: row.zoneId, atom };
    } catch (error) {
      this.logger.error(`Failed to derive DNS zone atom for zone ${zoneId}: ${getErrorMessage(error)}`);
      return { status: 'error' };
    }
  }

  async deriveAllPrefixes(): Promise<DeriveAllPrefixesResult> {
    let rows: PrefixDnsRow[];
    try {
      rows = await this.listDnsOverridePrefixes();
    } catch (error) {
      this.logger.error(
        `DNS deriveAllPrefixes: prefix query failed, preserving current atoms: ${getErrorMessage(error)}`,
      );
      return { atoms: [], enabledKeys: new Set(), queryFailed: true };
    }

    const enabledKeys = new Set(rows.map((r) => `${r.zoneId}:${r.prefixId}`));
    const atoms: Array<{ prefixId: string; zoneId: string; atom: DnsPrefixOverrideAtom }> = [];

    for (const row of rows) {
      try {
        const atom = this.buildPrefixAtom(row);
        atoms.push({ prefixId: row.prefixId, zoneId: row.zoneId, atom });
      } catch (error) {
        this.logger.error(
          `Failed to derive DNS prefix override atom for prefix ${row.prefixId}: ${getErrorMessage(error)}`,
        );
      }
    }

    return { atoms, enabledKeys, queryFailed: false };
  }

  async deriveOnePrefix(prefixId: string): Promise<DerivePrefixResult> {
    let rows: PrefixDnsRow[];
    try {
      rows = await this.listDnsOverridePrefixes(prefixId);
    } catch (error) {
      this.logger.error(`Failed to query prefix ${prefixId} for DNS derivation: ${getErrorMessage(error)}`);
      return { status: 'error' };
    }

    const row = rows[0];
    if (!row) return { status: 'not_found' };

    try {
      const atom = this.buildPrefixAtom(row);
      return { status: 'ok', zoneId: row.zoneId, atom };
    } catch (error) {
      this.logger.error(`Failed to derive DNS prefix override atom for prefix ${prefixId}: ${getErrorMessage(error)}`);
      return { status: 'error' };
    }
  }

  buildZoneAtom(row: ZoneDnsRow): DnsConfigAtom {
    const upstreamResolvers = row.dnsUpstreamResolvers.filter((ip) => {
      if (isIPv4(ip)) return true;
      this.logger.warn(`DNS zone ${row.zoneId}: upstream resolver ${JSON.stringify(ip)} is not IPv4, omitting`);
      return false;
    });

    const raw = {
      enabled: row.dnsEnabled,
      upstreamResolvers: [...upstreamResolvers].sort(),
      ttlSeconds: row.dnsTtlSeconds,
      cacheSize: row.dnsCacheSize,
      ownedDomain: row.dnsOwnedDomain || 'lan',
      hostnames: [...row.bridgeHostnames].sort(),
      upstreamTimeoutMs: Math.max(row.dnsUpstreamTimeoutMs, 1),
      pollMs: Math.max(row.dnsPollMs, 1),
      tcpEnabled: true,
      tcpMaxConnections: row.dnsTcpMaxConnections != null ? Math.max(row.dnsTcpMaxConnections, 1) : undefined,
      tcpMaxQueriesPerConn: row.dnsTcpMaxQueriesPerConn != null ? Math.max(row.dnsTcpMaxQueriesPerConn, 1) : undefined,
      tcpIdleTimeoutMs: row.dnsTcpIdleTimeoutMs != null ? Math.max(row.dnsTcpIdleTimeoutMs, 1) : undefined,
      tcpMaxMessageBytes: row.dnsTcpMaxMessageBytes != null ? Math.max(row.dnsTcpMaxMessageBytes, 1) : undefined,
      maxTtlSeconds: row.dnsMaxTtlSeconds ?? undefined,
      maxCacheTtlSeconds: row.dnsMaxCacheTtlSeconds ?? undefined,
      minCacheTtlSeconds: row.dnsMinCacheTtlSeconds ?? undefined,
      negTtlSeconds: row.dnsNegTtlSeconds ?? undefined,
    };

    return DnsConfigAtomSchema.parse(raw);
  }

  buildPrefixAtom(row: PrefixDnsRow): DnsPrefixOverrideAtom {
    const upstreamOverride = row.dnsUpstreamOverride.filter((ip) => {
      if (isIPv4(ip)) return true;
      this.logger.warn(`DNS prefix ${row.prefixId}: upstream override ${JSON.stringify(ip)} is not IPv4, omitting`);
      return false;
    });

    const raw = {
      serveDns: row.dnsServeDns,
      upstreamOverride: [...upstreamOverride].sort(),
    };

    return DnsPrefixOverrideAtomSchema.parse(raw);
  }

  private async listDnsZones(zoneId?: string): Promise<ZoneDnsRow[]> {
    return this.prisma.zone
      .findMany({
        where: {
          deletedAt: null,
          ...(zoneId ? { id: zoneId } : {}),
        },
        select: {
          id: true,
          ...DNS_ZONE_BASE_SELECT,
          devices: {
            where: { bridge: { isNot: null }, deletedAt: null },
            select: { name: true },
            orderBy: { name: 'asc' },
          },
        },
      })
      .then((rows) =>
        rows.map((r) => ({
          zoneId: r.id,
          dnsEnabled: r.dnsEnabled,
          dnsUpstreamResolvers: r.dnsUpstreamResolvers,
          dnsTtlSeconds: r.dnsTtlSeconds,
          dnsCacheSize: r.dnsCacheSize,
          dnsOwnedDomain: r.dnsOwnedDomain,
          dnsUpstreamTimeoutMs: r.dnsUpstreamTimeoutMs,
          dnsPollMs: r.dnsPollMs,
          dnsTcpMaxConnections: r.dnsTcpMaxConnections,
          dnsTcpMaxQueriesPerConn: r.dnsTcpMaxQueriesPerConn,
          dnsTcpIdleTimeoutMs: r.dnsTcpIdleTimeoutMs,
          dnsTcpMaxMessageBytes: r.dnsTcpMaxMessageBytes,
          dnsMaxTtlSeconds: r.dnsMaxTtlSeconds,
          dnsMaxCacheTtlSeconds: r.dnsMaxCacheTtlSeconds,
          dnsMinCacheTtlSeconds: r.dnsMinCacheTtlSeconds,
          dnsNegTtlSeconds: r.dnsNegTtlSeconds,
          bridgeHostnames: r.devices.map((d) => d.name),
        })),
      );
  }

  // A prefix has a DNS override when it has dnsServeDns set or a non-empty dnsUpstreamOverride.
  private async listDnsOverridePrefixes(prefixId?: string): Promise<PrefixDnsRow[]> {
    return this.prisma.prefix
      .findMany({
        where: {
          deletedAt: null,
          zoneId: { not: null },
          zone: { deletedAt: null },
          ...(prefixId ? { id: prefixId } : {}),
          OR: [{ dnsServeDns: { not: null } }, { dnsUpstreamOverride: { isEmpty: false } }],
        },
        select: {
          id: true,
          zoneId: true,
          dnsServeDns: true,
          dnsUpstreamOverride: true,
        },
      })
      .then((rows) =>
        rows
          .filter((r): r is typeof r & { zoneId: string } => r.zoneId !== null)
          .map((r) => ({
            prefixId: r.id,
            zoneId: r.zoneId,
            dnsServeDns: r.dnsServeDns,
            dnsUpstreamOverride: r.dnsUpstreamOverride,
          })),
      );
  }
}
