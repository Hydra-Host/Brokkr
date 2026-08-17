import { Injectable } from '@nestjs/common';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { DnsConfigRedisWriterService } from './dns-config-redis-writer.service';
import { DnsDerivationService } from './dns-derivation.service';

@Injectable()
export class DnsConfigPublisherService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly derivation: DnsDerivationService,
    private readonly writer: DnsConfigRedisWriterService,
    @Logger(DnsConfigPublisherService.name) private readonly logger: LoggerService,
  ) {}

  async publishZoneDnsConfig(zoneId: string): Promise<boolean> {
    try {
      const derived = await this.derivation.deriveOneZone(zoneId);
      if (derived.status === 'ok') {
        const result = await this.writer.setZone(derived.zoneId, derived.atom);
        // STALE = a newer atom already won on the target zone, so relocate may clear the old zone;
        // only a genuine write error (which throws) leaves the old atom live. Mirrors DHCP republishOne.
        return result.written || result.reason === 'stale';
      } else if (derived.status === 'not_found') {
        await this.writer.clearZone(zoneId);
        return true;
      }
      return false;
    } catch (error) {
      this.logger.warn(
        `Eager DNS zone config publish failed for zone ${zoneId} (reconcile cron will heal): ${getErrorMessage(error)}`,
      );
      return false;
    }
  }

  async clearZoneDnsConfig(zoneId: string): Promise<void> {
    try {
      await this.writer.clearZone(zoneId);
    } catch (error) {
      this.logger.warn(
        `Eager DNS zone config clear failed for zone ${zoneId} (reconcile cron will heal): ${getErrorMessage(error)}`,
      );
    }
  }

  async publishPrefixDnsOverride(prefixId: string): Promise<boolean> {
    try {
      const derived = await this.derivation.deriveOnePrefix(prefixId);
      if (derived.status === 'ok') {
        const result = await this.writer.setPrefix(derived.zoneId, prefixId, derived.atom);
        return result.written || result.reason === 'stale';
      } else if (derived.status === 'not_found') {
        // Override cleared — eagerly DEL the stale atom (mirrors the zone path above).
        const zoneId =
          (await this.prisma.prefix.findUnique({ where: { id: prefixId }, select: { zoneId: true } }))?.zoneId ?? null;
        if (zoneId) await this.writer.clearPrefix(zoneId, prefixId);
        return true;
      }
      return false;
    } catch (error) {
      this.logger.warn(
        `Eager DNS prefix override publish failed for prefix ${prefixId} (reconcile cron will heal): ${getErrorMessage(error)}`,
      );
      return false;
    }
  }

  async clearPrefixDnsOverride(zoneId: string, prefixId: string): Promise<void> {
    try {
      await this.writer.clearPrefix(zoneId, prefixId);
    } catch (error) {
      this.logger.warn(
        `Eager DNS prefix override clear failed for prefix ${prefixId} (reconcile cron will heal): ${getErrorMessage(error)}`,
      );
    }
  }
}
