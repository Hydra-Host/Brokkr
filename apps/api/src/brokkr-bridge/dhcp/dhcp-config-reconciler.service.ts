import { Inject, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import Redis from 'ioredis';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import {
  atomsMatch,
  ConfigAtomWriter,
  DHCP_CONFIG_SCAN_PATTERN,
  DHCP_ZONE_CONFIG_KEY,
  dhcpConfig,
  REDIS_CLIENT,
  scanKeys,
} from 'src/common/redis';
import { LoggerService } from 'src/logger/logger.service';
import { DhcpAtomSchema, DhcpZoneOpsAtomSchema, type DhcpAtom, type DhcpZoneOpsAtom } from './dhcp-atom.schema';
import { DhcpConfigRedisWriterService } from './dhcp-config-redis-writer.service';
import { DhcpDerivationService } from './dhcp-derivation.service';

const DHCP_SCAN_PATTERN = '*:prefix:*:config:dhcp';
const DHCP_KEY_RE = /^(.+):prefix:(.+):config:dhcp$/;
const DHCP_ZONE_KEY_RE = /^([^:]+):config:dhcp$/;

interface DhcpDesiredEntry {
  prefixId: string;
  zoneId: string;
  atom: DhcpAtom;
}

interface DhcpPublishedEntry {
  prefixId: string;
  zoneId: string;
  atom: DhcpAtom | null;
}

// Background job, no request context — cross-tenant via raw queries by design.
@Injectable()
export class DhcpConfigReconcilerService {
  private running = false;

  constructor(
    private readonly derivation: DhcpDerivationService,
    private readonly dhcpWriter: DhcpConfigRedisWriterService,
    private readonly atomWriter: ConfigAtomWriter,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Logger(DhcpConfigReconcilerService.name) private readonly logger: LoggerService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'dhcp-config-reconciler' })
  async handleCron(): Promise<void> {
    if (this.running) {
      this.logger.warn('Skipping DHCP config reconcile — previous run still in flight');
      return;
    }
    this.running = true;
    try {
      await this.reconcile();
      await this.reconcileZoneOps();
    } catch (error) {
      this.logger.error(`DHCP config reconcile failed: ${getErrorMessage(error)}`);
    } finally {
      this.running = false;
    }
  }

  private async reconcile(): Promise<void> {
    // Read Redis BEFORE the DB (reverse of write order) — else a clear that commits+DELs between
    // the two reads gets republished this tick. Same TOCTOU guard as VrrpReconciler.
    const published = await this.scanPublished();
    const publishedByKey = new Map<string, DhcpPublishedEntry>(
      published.map((entry) => [`${entry.zoneId}:${entry.prefixId}`, entry]),
    );

    const { atoms: desired, enabledKeys } = await this.derivation.deriveAll();
    const desiredByKey = new Map<string, DhcpDesiredEntry>(
      desired.map((entry) => [`${entry.zoneId}:${entry.prefixId}`, entry]),
    );

    // Missing or divergent: DB wants an atom that Redis doesn't have or
    // holds a stale/wrong-zone/wrong-value copy of.
    for (const entry of desired) {
      const key = `${entry.zoneId}:${entry.prefixId}`;
      const current = publishedByKey.get(key);
      if (current && atomsMatch(entry.atom, current.atom)) continue;
      try {
        const writeResult = await this.dhcpWriter.set(entry.zoneId, entry.prefixId, entry.atom);
        if (writeResult.written) {
          this.logger.warn(
            `Reconciled DHCP config for prefix ${entry.prefixId}: republished under zone ${entry.zoneId} (${
              current ? 'divergent' : 'missing'
            })`,
          );
        }
      } catch (error) {
        this.logger.error(`Failed to republish DHCP config for prefix ${entry.prefixId}: ${getErrorMessage(error)}`);
      }
    }

    // Orphans are matched on zoneId+prefixId so a zone-relocated prefix's old-zone atom is
    // cleared even though the prefix is still DHCP-enabled under its new zone.
    for (const entry of published) {
      const key = `${entry.zoneId}:${entry.prefixId}`;
      if (desiredByKey.has(key)) continue;
      if (enabledKeys.has(key)) {
        // Still DHCP-enabled but derivation threw this tick — do NOT clear (that takes DHCP down
        // for a live prefix); preserve the last-good atom until a later derive succeeds.
        this.logger.warn(
          `DHCP config for prefix ${entry.prefixId} (zone ${entry.zoneId}) failed to derive this tick — preserving published atom`,
        );
        continue;
      }
      try {
        await this.dhcpWriter.clear(entry.zoneId, entry.prefixId);
        this.logger.warn(`Cleared orphaned DHCP config atom for prefix ${entry.prefixId} in zone ${entry.zoneId}`);
      } catch (error) {
        this.logger.error(
          `Failed to clear orphaned DHCP config for prefix ${entry.prefixId} in zone ${entry.zoneId}: ${getErrorMessage(error)}`,
        );
      }
    }
  }

  // Zone-global ops atoms: desired = every live zone (columns have defaults, so an atom always
  // derives); orphans are atoms whose zone is gone/soft-deleted.
  private async reconcileZoneOps(): Promise<void> {
    const published = await this.scanPublishedZoneOps();
    const publishedByZoneId = new Map(published.map((entry) => [entry.zoneId, entry]));

    const { atoms: desired, liveZoneIds, queryFailed } = await this.derivation.deriveAllZoneOps();
    if (queryFailed) return;

    for (const entry of desired) {
      const current = publishedByZoneId.get(entry.zoneId);
      if (current && atomsMatch(entry.atom, current.atom)) continue;
      try {
        const writeResult = await this.dhcpWriter.setZoneOps(entry.zoneId, entry.atom);
        if (writeResult.written) {
          this.logger.warn(`Reconciled DHCP zone ops for zone ${entry.zoneId} (${current ? 'divergent' : 'missing'})`);
        }
      } catch (error) {
        this.logger.error(`Failed to republish DHCP zone ops for zone ${entry.zoneId}: ${getErrorMessage(error)}`);
      }
    }

    for (const entry of published) {
      if (liveZoneIds.has(entry.zoneId)) continue;
      try {
        await this.dhcpWriter.clearZoneOps(entry.zoneId);
        this.logger.warn(`Cleared orphaned DHCP zone ops atom for zone ${entry.zoneId}`);
      } catch (error) {
        this.logger.error(`Failed to clear orphaned DHCP zone ops for zone ${entry.zoneId}: ${getErrorMessage(error)}`);
      }
    }
  }

  private async scanPublishedZoneOps(): Promise<Array<{ zoneId: string; atom: DhcpZoneOpsAtom | null }>> {
    const keys = await scanKeys(this.redis, DHCP_CONFIG_SCAN_PATTERN);
    const zoneIds = keys
      .map((key) => key.match(DHCP_ZONE_KEY_RE)?.[1])
      .filter((zoneId): zoneId is string => zoneId !== undefined);
    const reads = zoneIds.map(async (zoneId) => {
      try {
        const value = await this.atomWriter.readAtom(zoneId, DHCP_ZONE_CONFIG_KEY, DhcpZoneOpsAtomSchema);
        return { zoneId, atom: value };
      } catch (error) {
        this.logger.warn(
          `Failed to read DHCP zone ops atom for zone ${zoneId}: ${getErrorMessage(error)} — treating as divergent`,
        );
        return { zoneId, atom: null };
      }
    });
    return Promise.all(reads);
  }

  private async scanPublished(): Promise<DhcpPublishedEntry[]> {
    const keys = await scanKeys(this.redis, DHCP_SCAN_PATTERN);
    const reads = keys.map(async (key): Promise<DhcpPublishedEntry | null> => {
      const match = DHCP_KEY_RE.exec(key);
      if (!match) {
        this.logger.warn(`Unrecognized DHCP atom key shape: ${key} — skipping`);
        return null;
      }
      const [, zoneId, prefixId] = match;
      try {
        const value = await this.atomWriter.readAtom(zoneId, dhcpConfig(prefixId), DhcpAtomSchema);
        return { prefixId, zoneId, atom: value };
      } catch (error) {
        this.logger.warn(`Failed to read DHCP atom ${key}: ${getErrorMessage(error)} — treating as divergent`);
        return { prefixId, zoneId, atom: null };
      }
    });
    return (await Promise.all(reads)).filter((entry) => entry !== null);
  }
}
