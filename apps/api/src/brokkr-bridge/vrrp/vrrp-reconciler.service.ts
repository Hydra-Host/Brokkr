import { Inject, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import Redis from 'ioredis';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { ConfigAtomWriter, REDIS_CLIENT, scanKeys, vrrpConfig } from 'src/common/redis';
import { PrefixRepository } from 'src/ipam/prefix/prefix.repository';
import { LoggerService } from 'src/logger/logger.service';
import { VrrpAtomSchema } from './vrrp-atom.schema';
import { VrrpRedisWriterService } from './vrrp-redis-writer.service';

const SCAN_COUNT = 100;
const VRRP_SCAN_PATTERN = '*:prefix:*:config:vrrp';
const VRRP_KEY_RE = /^(.+):prefix:(.+):config:vrrp$/;

interface VrrpDesiredEntry {
  prefixId: string;
  zoneId: string;
  vip: string;
  ifaceByBridge: Record<string, string>;
  garpCount: number;
}

interface VrrpPublishedEntry {
  prefixId: string;
  zoneId: string;
  vip: string | null;
  ifaceByBridge: Record<string, string> | null;
  garpCount: number | null;
}

function sameIfaceByBridge(a: Record<string, string>, b: Record<string, string> | null): boolean {
  if (b === null) return false;
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every((key) => a[key] === b[key]);
}

@Injectable()
export class VrrpReconcilerService {
  private running = false;

  constructor(
    private readonly prefixRepository: PrefixRepository,
    private readonly vrrpWriter: VrrpRedisWriterService,
    private readonly atomWriter: ConfigAtomWriter,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Logger(VrrpReconcilerService.name) private readonly logger: LoggerService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'vrrp-vip-reconciler' })
  async handleCron(): Promise<void> {
    if (this.running) {
      this.logger.warn('Skipping VRRP VIP reconcile — previous run still in flight');
      return;
    }
    this.running = true;
    try {
      await this.reconcile();
    } catch (error) {
      this.logger.error(`VRRP VIP reconcile failed: ${getErrorMessage(error)}`);
    } finally {
      this.running = false;
    }
  }

  private async reconcile(): Promise<void> {
    const published = await this.scanPublished();
    const publishedByPrefixId = new Map<string, VrrpPublishedEntry>(published.map((entry) => [entry.prefixId, entry]));

    const desired = await this.prefixRepository.listAllVrrpVipBearingPrefixes();
    const desiredByPrefixId = new Map<string, VrrpDesiredEntry>(desired.map((entry) => [entry.prefixId, entry]));

    // Missing/divergent: writeAtomJson is last-newer-wins, so a concurrent live publish is never clobbered.
    for (const entry of desired) {
      const current = publishedByPrefixId.get(entry.prefixId);
      const matches =
        current !== undefined &&
        current.zoneId === entry.zoneId &&
        current.vip === entry.vip &&
        current.garpCount === entry.garpCount &&
        sameIfaceByBridge(entry.ifaceByBridge, current.ifaceByBridge);
      if (matches) continue;
      try {
        await this.vrrpWriter.set(entry.zoneId, entry.prefixId, entry.vip, entry.ifaceByBridge, entry.garpCount);
        this.logger.warn(
          `Reconciled VRRP VIP for prefix ${entry.prefixId}: republished under zone ${entry.zoneId} (${
            current ? 'divergent' : 'missing'
          })`,
        );
      } catch (error) {
        this.logger.error(`Failed to republish VRRP VIP for prefix ${entry.prefixId}: ${getErrorMessage(error)}`);
      }
    }

    for (const entry of published) {
      const wanted = desiredByPrefixId.get(entry.prefixId);
      const stillWanted = wanted !== undefined && wanted.zoneId === entry.zoneId;
      if (stillWanted) continue;
      try {
        await this.vrrpWriter.clear(entry.zoneId, entry.prefixId);
        this.logger.warn(`Cleared orphaned VRRP VIP atom for prefix ${entry.prefixId} in zone ${entry.zoneId}`);
      } catch (error) {
        this.logger.error(
          `Failed to clear orphaned VRRP VIP atom for prefix ${entry.prefixId} in zone ${entry.zoneId}: ${getErrorMessage(error)}`,
        );
      }
    }
  }

  private async scanPublished(): Promise<VrrpPublishedEntry[]> {
    const keys = await this.scanVrrpKeys();
    const reads = keys.map(async (key): Promise<VrrpPublishedEntry | null> => {
      const match = VRRP_KEY_RE.exec(key);
      if (!match) {
        this.logger.warn(`Unrecognized VRRP atom key shape: ${key} — skipping`);
        return null;
      }
      const [, zoneId, prefixId] = match;
      try {
        const value = await this.atomWriter.readAtom(zoneId, vrrpConfig(prefixId), VrrpAtomSchema);
        return {
          prefixId,
          zoneId,
          vip: value?.vip ?? null,
          ifaceByBridge: value?.ifaceByBridge ?? null,
          garpCount: value?.garpCount ?? null,
        };
      } catch (error) {
        this.logger.warn(`Failed to read VRRP atom ${key}: ${getErrorMessage(error)} — treating as divergent`);
        return { prefixId, zoneId, vip: null, ifaceByBridge: null, garpCount: null };
      }
    });
    return (await Promise.all(reads)).filter((entry) => entry !== null);
  }

  private async scanVrrpKeys(): Promise<string[]> {
    return scanKeys(this.redis, VRRP_SCAN_PATTERN, SCAN_COUNT);
  }
}
