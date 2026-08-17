import { Injectable } from '@nestjs/common';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { DhcpConfigRedisWriterService } from './dhcp-config-redis-writer.service';
import { DhcpDerivationService } from './dhcp-derivation.service';

// Talks to Prisma + derivation/writer directly (never IPAM/device services) so callers in those
// domains can depend on it without a circular module reference.
@Injectable()
export class DhcpConfigPublisherService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly derivation: DhcpDerivationService,
    private readonly writer: DhcpConfigRedisWriterService,
    @Logger(DhcpConfigPublisherService.name) private readonly logger: LoggerService,
  ) {}

  // Non-throwing: an atom-publish hiccup must never fail the caller's own write.
  async republishPrefixes(prefixIds: string[]): Promise<void> {
    for (const prefixId of new Set(prefixIds)) {
      await this.republishOne(prefixId);
    }
  }

  async publishZoneOps(zoneId: string): Promise<boolean> {
    try {
      const derived = await this.derivation.deriveOneZoneOps(zoneId);
      if (derived.status === 'ok') {
        const result = await this.writer.setZoneOps(zoneId, derived.atom);
        return result.written || result.reason === 'stale';
      } else if (derived.status === 'not_found') {
        await this.writer.clearZoneOps(zoneId);
        return true;
      }
      return false;
    } catch (error) {
      this.logger.warn(
        `Eager DHCP zone ops publish failed for zone ${zoneId} (reconcile cron will heal): ${getErrorMessage(error)}`,
      );
      return false;
    }
  }

  // Non-throwing; returns false on 'error'/throw — callers (e.g. relocateDhcpAtom) treat that as
  // "old-zone atom NOT safe to clear".
  async republishOne(prefixId: string, resolveZoneId?: () => Promise<string | null>): Promise<boolean> {
    try {
      const derived = await this.derivation.deriveOne(prefixId);
      if (derived.status === 'enabled') {
        await this.writer.set(derived.zoneId, prefixId, derived.atom);
        return true;
      } else if (derived.status === 'disabled') {
        // Not DHCP-eligible — clear any stale atom. deriveOne omits the zone on 'disabled', so
        // resolve it via the callback or a cross-tenant read.
        const zoneId = resolveZoneId
          ? await resolveZoneId()
          : ((await this.prisma.prefix.findUnique({ where: { id: prefixId }, select: { zoneId: true } }))?.zoneId ??
            null);
        if (zoneId) await this.writer.clear(zoneId, prefixId);
        return true;
      }
      // status 'error': leave the existing atom; DhcpConfigReconcilerService heals it.
      return false;
    } catch (error) {
      this.logger.warn(
        `Eager DHCP republish failed for prefix ${prefixId} (reconcile cron will heal): ${getErrorMessage(error)}`,
      );
      return false;
    }
  }

  // <<= (not strict <<) must mirror DhcpDerivationService.loadReservations: host IPs are often
  // stored with their mask (10.0.0.5/24), which << misses — republish would silently skip the prefix.
  async republishForDevice(deviceId: string): Promise<void> {
    await this.resolveAndRepublish(
      `device ${deviceId}`,
      () => this.prisma.$queryRaw<Array<{ prefixId: string }>>`
        SELECT DISTINCT p.id AS "prefixId"
        FROM "Prefix" p
        JOIN "IpAddress" ip
          ON ip.address <<= p.prefix
          AND ip."organizationId" = p."organizationId"
          AND ip."vrfId" IS NOT DISTINCT FROM p."vrfId"
          AND ip."deletedAt" IS NULL
        JOIN "Interface" iface
          ON iface.id = ip."interfaceId"
          AND iface."deviceId" = ${deviceId}
          AND iface."deletedAt" IS NULL
        WHERE p."deletedAt" IS NULL
          AND p."dhcpMode" IS NOT NULL
          AND family(ip.address) = 4
      `,
    );
  }

  // Deliberately no filter on the IP's own deletedAt: a just-archived IP must still resolve its
  // prefix so the re-derived atom drops the now-deleted reservation.
  async republishForIpAddress(ipAddressId: string): Promise<void> {
    await this.resolveAndRepublish(
      `ip ${ipAddressId}`,
      () => this.prisma.$queryRaw<Array<{ prefixId: string }>>`
        SELECT p.id AS "prefixId"
        FROM "IpAddress" ip
        JOIN "Prefix" p
          ON ip.address <<= p.prefix
          AND ip."organizationId" = p."organizationId"
          AND ip."vrfId" IS NOT DISTINCT FROM p."vrfId"
        WHERE ip.id = ${ipAddressId}
          AND p."deletedAt" IS NULL
          AND p."dhcpMode" IS NOT NULL
          AND family(ip.address) = 4
      `,
    );
  }

  // Refreshes the OLD prefix after an IP's VRF/address change — the IP now resolves elsewhere, so
  // republishForIpAddress alone would leave the old atom's reservation stale until the cron.
  async republishForReservation(address: string, organizationId: string, vrfId: string | null): Promise<void> {
    await this.resolveAndRepublish(
      `reservation ${address}`,
      () => this.prisma.$queryRaw<Array<{ prefixId: string }>>`
        SELECT p.id AS "prefixId"
        FROM "Prefix" p
        WHERE p."deletedAt" IS NULL
          AND p."dhcpMode" IS NOT NULL
          AND p."organizationId" = ${organizationId}
          AND p."vrfId" IS NOT DISTINCT FROM ${vrfId}
          AND ${address}::inet <<= p.prefix
          AND family(${address}::inet) = 4
      `,
    );
  }

  // Non-throwing: runs AFTER the caller's mutation committed — a lookup failure must never turn
  // that successful write into a 500 (the reconcile cron heals).
  private async resolveAndRepublish(label: string, query: () => Promise<Array<{ prefixId: string }>>): Promise<void> {
    let rows: Array<{ prefixId: string }>;
    try {
      rows = await query();
    } catch (error) {
      this.logger.warn(
        `Eager DHCP republish (${label}): prefix lookup failed, skipping — reconcile cron will heal (${getErrorMessage(error)})`,
      );
      return;
    }
    await this.republishPrefixes(rows.map((r) => r.prefixId));
  }
}
