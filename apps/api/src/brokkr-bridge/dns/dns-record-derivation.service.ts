import { isIPv4 } from 'node:net';

import { Injectable } from '@nestjs/common';
import { DNS_LABEL_RE } from '@repo/api-client';
import { Prisma } from '@repo/database';
import { ipInCidr } from '@repo/utils';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';

const DEFAULT_OWNED_DOMAIN = 'lan';

/** Coerce a raw name to a valid single DNS label, or return null if impossible. */
export function sanitizeDnsLabel(raw: string): string | null {
  const lower = raw.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const trimmed = lower.replace(/^-+|-+$/g, '');
  const clamped = trimmed.slice(0, 63);
  const final = clamped.replace(/-+$/, '');
  if (!final || !DNS_LABEL_RE.test(final)) return null;
  return final;
}

interface DeviceIpRow {
  deviceId: string;
  hostname: string;
  ipAddressId: string;
  address: string;
}

interface DnsNameIpRow {
  ipAddressId: string;
  dnsName: string;
  address: string;
}

interface DerivedRecord {
  domainId: string;
  name: string;
  type: 'A' | 'AAAA' | 'PTR';
  value: string;
  source: 'AUTO';
  deviceId: string | null;
  ipAddressId: string | null;
}

@Injectable()
export class DnsRecordDerivationService {
  constructor(
    private readonly prisma: PrismaClient,
    @Logger(DnsRecordDerivationService.name) private readonly logger: LoggerService,
  ) {}

  async rederiveAll(): Promise<void> {
    const zoneIdsWithIps = await this.loadZonesWithDeviceIps();
    const zoneIdsWithDnsNameIps = await this.loadZonesWithDnsNameIps();
    const zoneIdsWithAutoRecords = await this.loadZonesWithAutoRecords();
    const allZoneIds = new Set([...zoneIdsWithIps, ...zoneIdsWithDnsNameIps, ...zoneIdsWithAutoRecords]);
    for (const zoneId of allZoneIds) {
      await this.deriveForZone(zoneId);
    }
  }

  async deriveForZone(zoneId: string): Promise<void> {
    try {
      const zone = await this.prisma.zone.findUnique({
        where: { id: zoneId },
        select: { id: true, deletedAt: true, dnsEnabled: true },
      });
      if (!zone || zone.deletedAt) return;
      // A DNS-disabled zone must stay atom-free; purge AUTO records left over from an
      // enabled→disabled transition so the zone also drops out of the rederive sweep.
      if (!zone.dnsEnabled) {
        await this.deleteAutoRecordsForZone(zoneId);
        return;
      }

      const forwardDomain = await this.resolveOrCreateForwardDomain(zoneId);
      const deviceRows = await this.loadDeviceIps(zoneId);
      const dnsNameRows = await this.loadDnsNameIps(zoneId);

      const derived: DerivedRecord[] = [];

      for (const row of deviceRows) {
        const label = sanitizeDnsLabel(row.hostname);
        if (!label) continue;
        const type = isIPv4(row.address) ? 'A' : 'AAAA';
        derived.push({
          domainId: forwardDomain.id,
          name: label,
          type,
          value: row.address,
          source: 'AUTO',
          deviceId: row.deviceId,
          ipAddressId: row.ipAddressId,
        });
      }

      for (const row of dnsNameRows) {
        const label = sanitizeDnsLabel(row.dnsName);
        if (!label) continue;
        const type = isIPv4(row.address) ? 'A' : 'AAAA';
        derived.push({
          domainId: forwardDomain.id,
          name: label,
          type,
          value: row.address,
          source: 'AUTO',
          deviceId: null,
          ipAddressId: row.ipAddressId,
        });
      }

      const prefixRows = await this.loadPrefixesForReverse(zoneId);
      const reverseDomains = new Map<string, { id: string }>();

      for (const pRow of prefixRows) {
        const reverseName = ipToReverseDomainName(pRow.network, pRow.prefixLength);
        if (!reverseDomains.has(reverseName)) {
          const domain = await this.ensureReverseDomain(zoneId, reverseName);
          reverseDomains.set(reverseName, domain);
        }
      }

      const orphanedReverseDomainIds = await this.loadOrphanedReverseDomainIds(
        zoneId,
        Array.from(reverseDomains.values()).map((d) => d.id),
      );

      const allDomainIds = [
        forwardDomain.id,
        ...Array.from(reverseDomains.values()).map((d) => d.id),
        ...orphanedReverseDomainIds,
      ];

      const deduped = this.deduplicateRecords(derived);
      const forwardFiltered = await this.excludeManualCollisions(deduped, allDomainIds);

      const ptrRecords: DerivedRecord[] = [];
      for (const rec of forwardFiltered) {
        if (rec.type !== 'A' && rec.type !== 'AAAA') continue;

        const matchingPrefix = prefixRows.find((p) => ipInPrefix(rec.value, p.network, p.prefixLength));
        if (!matchingPrefix) continue;

        const reverseName = ipToReverseDomainName(matchingPrefix.network, matchingPrefix.prefixLength);
        const reverseDomain = reverseDomains.get(reverseName);
        if (!reverseDomain) continue;

        const ptrName = ipToPtrHostName(rec.value, matchingPrefix.prefixLength);
        // /32 (v4) & /128 (v6) have no host label under the reverse zone — skip rather than emit an empty PTR name.
        if (!ptrName) continue;
        ptrRecords.push({
          domainId: reverseDomain.id,
          name: ptrName,
          type: 'PTR',
          value: `${rec.name}.${forwardDomain.name}`,
          source: 'AUTO',
          deviceId: rec.deviceId,
          ipAddressId: rec.ipAddressId,
        });
      }

      const ptrFiltered = await this.excludeManualCollisions(ptrRecords, allDomainIds);
      const filtered = [...forwardFiltered, ...ptrFiltered];
      const upsertedIds = await this.batchUpsertRecords(filtered);

      if (upsertedIds.length > 0) {
        await this.prisma.dnsRecord.deleteMany({
          where: {
            domainId: { in: allDomainIds },
            source: 'AUTO',
            id: { notIn: upsertedIds },
          },
        });
      } else {
        await this.prisma.dnsRecord.deleteMany({
          where: {
            domainId: { in: allDomainIds },
            source: 'AUTO',
          },
        });
      }

      // An empty published domain makes the bridge authoritative-with-NXDOMAIN for it, so
      // derivation-fed reverse domains that lost their last record must leave the atom.
      if (orphanedReverseDomainIds.length > 0) {
        await this.prisma.dnsDomain.updateMany({
          where: {
            id: { in: orphanedReverseDomainIds },
            deletedAt: null,
            records: { none: { deletedAt: null } },
          },
          data: { deletedAt: new Date() },
        });
      }
    } catch (error) {
      this.logger.error(`Failed to derive DNS records for zone ${zoneId}: ${getErrorMessage(error)}`);
    }
  }

  // Resolved by type (oldest active FORWARD domain), not by name — an operator rename of the
  // derivation target must follow the domain, not orphan it and respawn a fresh 'lan'.
  private async resolveOrCreateForwardDomain(zoneId: string): Promise<{ id: string; name: string }> {
    const existing = await this.prisma.dnsDomain.findFirst({
      where: { zoneId, type: 'FORWARD', deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true },
    });
    if (existing) return existing;
    try {
      return await this.prisma.dnsDomain.create({
        data: { zoneId, name: DEFAULT_OWNED_DOMAIN, type: 'FORWARD' },
        select: { id: true, name: true },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const race = await this.prisma.dnsDomain.findFirst({
          where: { zoneId, type: 'FORWARD', deletedAt: null },
          orderBy: { createdAt: 'asc' },
          select: { id: true, name: true },
        });
        if (race) return race;
      }
      throw error;
    }
  }

  private async ensureReverseDomain(zoneId: string, name: string): Promise<{ id: string }> {
    const existing = await this.prisma.dnsDomain.findFirst({
      where: { zoneId, name, deletedAt: null },
      select: { id: true },
    });
    if (existing) return existing;
    try {
      return await this.prisma.dnsDomain.create({
        data: { zoneId, name, type: 'REVERSE' },
        select: { id: true },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const race = await this.prisma.dnsDomain.findFirst({
          where: { zoneId, name, deletedAt: null },
          select: { id: true },
        });
        if (race) return race;
      }
      throw error;
    }
  }

  private async deleteAutoRecordsForZone(zoneId: string): Promise<void> {
    const domains = await this.prisma.dnsDomain.findMany({
      where: { zoneId, deletedAt: null },
      select: { id: true },
    });
    if (domains.length === 0) return;
    await this.prisma.dnsRecord.deleteMany({
      where: { domainId: { in: domains.map((d) => d.id) }, source: 'AUTO' },
    });
  }

  private async loadZonesWithAutoRecords(): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<Array<{ zoneId: string }>>`
      SELECT DISTINCT d."zoneId"
      FROM "DnsRecord" r
      JOIN "DnsDomain" d ON d.id = r."domainId" AND d."deletedAt" IS NULL
      WHERE r.source = 'AUTO'
        AND r."deletedAt" IS NULL
        AND d."zoneId" IS NOT NULL
    `;
    return rows.map((r) => r.zoneId);
  }

  private async loadZonesWithDeviceIps(): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<Array<{ zoneId: string }>>`
      SELECT DISTINCT d."zoneId"
      FROM "Device" d
      JOIN "Interface" iface ON iface."deviceId" = d.id AND iface."deletedAt" IS NULL
      JOIN "IpAddress" ip ON ip."interfaceId" = iface.id AND ip."deletedAt" IS NULL AND ip.status = 'ACTIVE'
      WHERE d."zoneId" IS NOT NULL
        AND d.name IS NOT NULL
        AND d."deletedAt" IS NULL
    `;
    return rows.map((r) => r.zoneId);
  }

  private async loadZonesWithDnsNameIps(): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<Array<{ zoneId: string }>>`
      SELECT DISTINCT d."zoneId"
      FROM "Device" d
      JOIN "Interface" iface ON iface."deviceId" = d.id AND iface."deletedAt" IS NULL
      JOIN "IpAddress" ip ON ip."interfaceId" = iface.id AND ip."deletedAt" IS NULL AND ip.status = 'ACTIVE'
      WHERE d."zoneId" IS NOT NULL
        AND ip."dnsName" IS NOT NULL
        AND d."deletedAt" IS NULL
    `;
    return rows.map((r) => r.zoneId);
  }

  private async loadDeviceIps(zoneId: string): Promise<DeviceIpRow[]> {
    return this.prisma.$queryRaw<DeviceIpRow[]>`
      SELECT
        d.id AS "deviceId",
        d.name AS hostname,
        ip.id AS "ipAddressId",
        host(ip.address) AS address
      FROM "Device" d
      JOIN "Interface" iface ON iface."deviceId" = d.id AND iface."deletedAt" IS NULL
      JOIN "IpAddress" ip ON ip."interfaceId" = iface.id AND ip."deletedAt" IS NULL AND ip.status = 'ACTIVE'
      WHERE d."zoneId" = ${zoneId}
        AND d.name IS NOT NULL
        AND d."deletedAt" IS NULL
    `;
  }

  private async loadDnsNameIps(zoneId: string): Promise<DnsNameIpRow[]> {
    return this.prisma.$queryRaw<DnsNameIpRow[]>`
      SELECT
        ip.id AS "ipAddressId",
        ip."dnsName",
        host(ip.address) AS address
      FROM "IpAddress" ip
      JOIN "Interface" iface ON iface.id = ip."interfaceId" AND iface."deletedAt" IS NULL
      JOIN "Device" d ON d.id = iface."deviceId" AND d."deletedAt" IS NULL
      WHERE ip."dnsName" IS NOT NULL
        AND ip."deletedAt" IS NULL
        AND ip.status = 'ACTIVE'
        AND d."zoneId" = ${zoneId}
    `;
  }

  private async loadPrefixesForReverse(zoneId: string): Promise<Array<{ network: string; prefixLength: number }>> {
    return this.prisma.$queryRaw<Array<{ network: string; prefixLength: number }>>`
      SELECT
        host(network(p.prefix)) AS network,
        masklen(p.prefix) AS "prefixLength"
      FROM "Prefix" p
      WHERE p."zoneId" = ${zoneId}
        AND p."deletedAt" IS NULL
      ORDER BY masklen(p.prefix) DESC, network(p.prefix) ASC
    `;
  }

  private async loadOrphanedReverseDomainIds(zoneId: string, currentReverseDomainIds: string[]): Promise<string[]> {
    const rows = await this.prisma.dnsDomain.findMany({
      where: {
        zoneId,
        type: 'REVERSE',
        deletedAt: null,
        id: { notIn: currentReverseDomainIds },
        records: { some: { source: 'AUTO', deletedAt: null } },
      },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  private async excludeManualCollisions(records: DerivedRecord[], domainIds: string[]): Promise<DerivedRecord[]> {
    if (records.length === 0 || domainIds.length === 0) return records;

    const manualRows = await this.prisma.dnsRecord.findMany({
      where: {
        domainId: { in: domainIds },
        source: 'MANUAL',
        deletedAt: null,
      },
      select: { domainId: true, name: true, type: true },
    });

    if (manualRows.length === 0) return records;

    const manualKeys = new Set(manualRows.map((r) => `${r.domainId}|${r.name.toLowerCase()}|${r.type}`));
    return records.filter((r) => !manualKeys.has(`${r.domainId}|${r.name.toLowerCase()}|${r.type}`));
  }

  private deduplicateRecords(records: DerivedRecord[]): DerivedRecord[] {
    const seen = new Set<string>();
    const result: DerivedRecord[] = [];
    for (const r of records) {
      const key = `${r.domainId}|${r.name}|${r.type}|${r.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(r);
    }
    return result;
  }

  private async batchUpsertRecords(records: DerivedRecord[]): Promise<string[]> {
    if (records.length === 0) return [];

    const values = records.map(
      (r) =>
        Prisma.sql`(gen_random_uuid(), ${r.domainId}, ${r.name}, ${r.type}::"DnsRecordType", ${r.value}, ${r.source}::"DnsRecordSource", ${r.deviceId}, ${r.ipAddressId}, now(), now(), NULL)`,
    );

    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`
        INSERT INTO "DnsRecord" ("id", "domainId", "name", "type", "value", "source", "deviceId", "ipAddressId", "createdAt", "updatedAt", "deletedAt")
        VALUES ${Prisma.join(values)}
        ON CONFLICT ("domainId", "name", "type", "value") WHERE "deletedAt" IS NULL
        DO UPDATE SET
          "deletedAt" = NULL,
          "deviceId" = EXCLUDED."deviceId",
          "ipAddressId" = EXCLUDED."ipAddressId",
          "updatedAt" = now()
        WHERE "DnsRecord"."source" = 'AUTO'::"DnsRecordSource"
        RETURNING "id"
      `,
    );

    return rows.map((r) => r.id);
  }
}

export function ipToReverseDomainName(network: string, prefixLength: number): string {
  if (network.includes(':')) {
    return ipv6ToReverseDomainName(network, prefixLength);
  }
  const octets = network.split('.').map((o) => parseInt(o, 10));
  // in-addr.arpa only supports byte-aligned delegation; truncate to the nearest byte boundary
  const significantOctets = Math.floor(prefixLength / 8);
  const clamped = Math.max(1, significantOctets);
  const reversed = octets.slice(0, clamped).reverse();
  return `${reversed.join('.')}.in-addr.arpa`;
}

function ipv6ToReverseDomainName(network: string, prefixLength: number): string {
  const expanded = expandIPv6(network);
  const nibbles = expanded.replace(/:/g, '').split('');
  const significantNibbles = Math.ceil(prefixLength / 4);
  const reversed = nibbles.slice(0, significantNibbles).reverse();
  return `${reversed.join('.')}.ip6.arpa`;
}

/** Host-relative fragment of a PTR name (what fqdnFromParts prefixes onto the reverse domain). */
export function ipToPtrHostName(ip: string, prefixLength: number): string {
  if (ip.includes(':')) {
    const expanded = expandIPv6(ip);
    const nibbles = expanded.replace(/:/g, '').split('').reverse();
    const domainNibbles = Math.ceil(prefixLength / 4);
    return nibbles.slice(0, nibbles.length - domainNibbles).join('.');
  }
  const octets = ip.split('.').reverse();
  const domainOctets = Math.max(1, Math.floor(prefixLength / 8));
  return octets.slice(0, octets.length - domainOctets).join('.');
}

function expandIPv6(ip: string): string {
  const doubleColonCount = (ip.match(/::/g) || []).length;
  if (doubleColonCount > 1) {
    throw new Error(`Invalid IPv6 address: multiple :: in "${ip}"`);
  }
  const parts = ip.split('::');
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts[1] ? parts[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  const fill = Array.from({ length: missing }, () => '0000');
  const groups = [...head, ...fill, ...tail];
  return groups.map((g) => g.padStart(4, '0')).join(':');
}

function ipInPrefix(ip: string, network: string, prefixLength: number): boolean {
  if (ip.includes(':') !== network.includes(':')) return false;

  if (!ip.includes(':')) {
    return ipInCidr(ip, `${network}/${prefixLength}`);
  }

  return ipv6InPrefix(ip, network, prefixLength);
}

function ipv6InPrefix(ip: string, network: string, prefixLength: number): boolean {
  const ipNibbles = expandIPv6(ip).replace(/:/g, '');
  const netNibbles = expandIPv6(network).replace(/:/g, '');
  const fullNibbles = Math.floor(prefixLength / 4);
  for (let i = 0; i < fullNibbles; i++) {
    if (ipNibbles[i] !== netNibbles[i]) return false;
  }
  const remainingBits = prefixLength % 4;
  if (remainingBits === 0) return true;
  const ipVal = parseInt(ipNibbles[fullNibbles], 16);
  const netVal = parseInt(netNibbles[fullNibbles], 16);
  const mask = (0xf << (4 - remainingBits)) & 0xf;
  return (ipVal & mask) === (netVal & mask);
}
