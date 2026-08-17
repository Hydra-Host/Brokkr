import { Inject, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import Redis from 'ioredis';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import {
  atomsMatch,
  ConfigAtomWriter,
  DNS_CONFIG_KEY,
  DNS_CONFIG_SCAN_PATTERN,
  DNS_PREFIX_CONFIG_SCAN_PATTERN,
  dnsPrefixConfig,
  REDIS_CLIENT,
  scanKeys,
} from 'src/common/redis';
import { LoggerService } from 'src/logger/logger.service';
import {
  DnsConfigAtomSchema,
  DnsPrefixOverrideAtomSchema,
  type DnsConfigAtom,
  type DnsPrefixOverrideAtom,
} from './dns-atom.schema';
import { DnsConfigRedisWriterService } from './dns-config-redis-writer.service';
import { DnsDerivationService } from './dns-derivation.service';

// Zone-global key: `{zoneUuid}:config:dns` — [^:]+ excludes per-prefix keys from the same SCAN.
const DNS_ZONE_KEY_RE = /^([^:]+):config:dns$/;
// Per-prefix key: `{zoneUuid}:prefix:{prefixId}:config:dns`
const DNS_PREFIX_KEY_RE = /^(.+):prefix:(.+):config:dns$/;

@Injectable()
export class DnsConfigReconcilerService {
  private running = false;

  constructor(
    private readonly derivation: DnsDerivationService,
    private readonly dnsWriter: DnsConfigRedisWriterService,
    private readonly atomWriter: ConfigAtomWriter,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Logger(DnsConfigReconcilerService.name) private readonly logger: LoggerService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'dns-config-reconciler' })
  async handleCron(): Promise<void> {
    if (this.running) {
      this.logger.warn('Skipping DNS config reconcile — previous run still in flight');
      return;
    }
    this.running = true;
    try {
      await this.reconcile();
    } catch (error) {
      this.logger.error(`DNS config reconcile failed: ${getErrorMessage(error)}`);
    } finally {
      this.running = false;
    }
  }

  private async reconcile(): Promise<void> {
    await this.reconcileZones();
    await this.reconcilePrefixes();
  }

  private async reconcileZones(): Promise<void> {
    const published = await this.scanPublishedZones();
    const publishedByKey = new Map(published.map((e) => [e.zoneId, e]));

    const { atoms: desired, enabledKeys, queryFailed } = await this.derivation.deriveAllZones();
    if (queryFailed) {
      this.logger.warn('DNS zone config reconcile: zone query failed — skipping orphan cleanup to preserve live atoms');
      return;
    }
    const desiredByKey = new Map(desired.map((e) => [e.zoneId, e]));

    for (const entry of desired) {
      const current = publishedByKey.get(entry.zoneId);
      if (current && atomsMatch(entry.atom, current.atom)) continue;
      try {
        const writeResult = await this.dnsWriter.setZone(entry.zoneId, entry.atom);
        if (writeResult.written) {
          this.logger.warn(
            `Reconciled DNS zone config for zone ${entry.zoneId}: republished (${current ? 'divergent' : 'missing'})`,
          );
        }
      } catch (error) {
        this.logger.error(`Failed to republish DNS zone config for zone ${entry.zoneId}: ${getErrorMessage(error)}`);
      }
    }

    for (const entry of published) {
      if (desiredByKey.has(entry.zoneId)) continue;
      if (enabledKeys.has(entry.zoneId)) {
        this.logger.warn(
          `DNS zone config for zone ${entry.zoneId} failed to derive this tick — preserving published atom`,
        );
        continue;
      }
      try {
        await this.dnsWriter.clearZone(entry.zoneId);
        this.logger.warn(`Cleared orphaned DNS zone config atom for zone ${entry.zoneId}`);
      } catch (error) {
        this.logger.error(
          `Failed to clear orphaned DNS zone config for zone ${entry.zoneId}: ${getErrorMessage(error)}`,
        );
      }
    }
  }

  private async reconcilePrefixes(): Promise<void> {
    const published = await this.scanPublishedPrefixes();
    const publishedByKey = new Map(published.map((e) => [`${e.zoneId}:${e.prefixId}`, e]));

    const { atoms: desired, enabledKeys, queryFailed } = await this.derivation.deriveAllPrefixes();
    if (queryFailed) {
      this.logger.warn(
        'DNS prefix override reconcile: prefix query failed — skipping orphan cleanup to preserve live atoms',
      );
      return;
    }
    const desiredByKey = new Map(desired.map((e) => [`${e.zoneId}:${e.prefixId}`, e]));

    for (const entry of desired) {
      const key = `${entry.zoneId}:${entry.prefixId}`;
      const current = publishedByKey.get(key);
      if (current && atomsMatch(entry.atom, current.atom)) continue;
      try {
        const writeResult = await this.dnsWriter.setPrefix(entry.zoneId, entry.prefixId, entry.atom);
        if (writeResult.written) {
          this.logger.warn(
            `Reconciled DNS prefix override for prefix ${entry.prefixId}: republished (${current ? 'divergent' : 'missing'})`,
          );
        }
      } catch (error) {
        this.logger.error(
          `Failed to republish DNS prefix override for prefix ${entry.prefixId}: ${getErrorMessage(error)}`,
        );
      }
    }

    for (const entry of published) {
      const key = `${entry.zoneId}:${entry.prefixId}`;
      if (desiredByKey.has(key)) continue;
      if (enabledKeys.has(key)) {
        this.logger.warn(
          `DNS prefix override for prefix ${entry.prefixId} (zone ${entry.zoneId}) failed to derive this tick — preserving published atom`,
        );
        continue;
      }
      try {
        await this.dnsWriter.clearPrefix(entry.zoneId, entry.prefixId);
        this.logger.warn(
          `Cleared orphaned DNS prefix override atom for prefix ${entry.prefixId} in zone ${entry.zoneId}`,
        );
      } catch (error) {
        this.logger.error(
          `Failed to clear orphaned DNS prefix override for prefix ${entry.prefixId} in zone ${entry.zoneId}: ${getErrorMessage(error)}`,
        );
      }
    }
  }

  private async scanPublishedZones(): Promise<Array<{ zoneId: string; atom: DnsConfigAtom | null }>> {
    const keys = await scanKeys(this.redis, DNS_CONFIG_SCAN_PATTERN);
    const reads = keys.map(async (key): Promise<{ zoneId: string; atom: DnsConfigAtom | null } | null> => {
      const match = DNS_ZONE_KEY_RE.exec(key);
      if (!match) {
        if (!DNS_PREFIX_KEY_RE.test(key)) {
          this.logger.warn(`Unrecognized DNS zone atom key shape: ${key} — skipping`);
        }
        return null;
      }
      const [, zoneId] = match;
      try {
        const value = await this.atomWriter.readAtom(zoneId, DNS_CONFIG_KEY, DnsConfigAtomSchema);
        return { zoneId, atom: value };
      } catch (error) {
        this.logger.warn(`Failed to read DNS zone atom ${key}: ${getErrorMessage(error)} — treating as divergent`);
        return { zoneId, atom: null };
      }
    });
    return (await Promise.all(reads)).filter((entry) => entry !== null);
  }

  private async scanPublishedPrefixes(): Promise<
    Array<{ prefixId: string; zoneId: string; atom: DnsPrefixOverrideAtom | null }>
  > {
    const keys = await scanKeys(this.redis, DNS_PREFIX_CONFIG_SCAN_PATTERN);
    const reads = keys.map(
      async (key): Promise<{ prefixId: string; zoneId: string; atom: DnsPrefixOverrideAtom | null } | null> => {
        const match = DNS_PREFIX_KEY_RE.exec(key);
        if (!match) {
          this.logger.warn(`Unrecognized DNS prefix atom key shape: ${key} — skipping`);
          return null;
        }
        const [, zoneId, prefixId] = match;
        try {
          const value = await this.atomWriter.readAtom(zoneId, dnsPrefixConfig(prefixId), DnsPrefixOverrideAtomSchema);
          return { prefixId, zoneId, atom: value };
        } catch (error) {
          this.logger.warn(`Failed to read DNS prefix atom ${key}: ${getErrorMessage(error)} — treating as divergent`);
          return { prefixId, zoneId, atom: null };
        }
      },
    );
    return (await Promise.all(reads)).filter((entry) => entry !== null);
  }
}
