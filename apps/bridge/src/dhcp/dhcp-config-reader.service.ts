import { getErrorMessage } from '../common/error-utils';
import { dhcpConfigScanPattern, dhcpZoneConfigKey } from '../common/redis/redis-keys';
import { readAtom, type AtomCache } from '../device-record/atom/atom-fetcher';
import { ContextLogger } from '../logger/logger.service';

import {
  DhcpAtomValueSchema,
  DhcpZoneOpsAtomValueSchema,
  type DhcpAtomValue,
  type DhcpZoneOpsAtomValue,
} from './dhcp-atom-value.schema';

// Regex to extract prefixId from atom keys of the form "prefix:<uuid>:config:dhcp".
const PREFIX_ID_PATTERN = /^prefix:([^:]+):config:dhcp$/;

/** Fail-closed: a Redis error must yield { ok: false } (callers preserve current state), never
 *  an empty map — an empty map tells the engine "no DHCP anywhere" — and must not throw. */
export type DhcpConfigReadResult = { ok: true; configs: Map<string, DhcpAtomValue> } | { ok: false };

export type AtomReaderRedis = AtomCache & {
  scan(pattern: string, jobId?: string): Promise<string[]>;
};

export class DhcpConfigReaderService {
  constructor(
    private readonly redis: AtomReaderRedis,
    private readonly logger: ContextLogger,
  ) {}

  async readAll(jobId: string = ''): Promise<DhcpConfigReadResult> {
    let keys: string[];
    try {
      keys = await this.redis.scan(dhcpConfigScanPattern(), jobId);
    } catch (error) {
      void this.logger.warning(`Failed to SCAN DHCP config atoms — returning unavailable: ${getErrorMessage(error)}`, {
        jobId,
      });
      return { ok: false };
    }

    const configs = new Map<string, DhcpAtomValue>();

    let values: Array<DhcpAtomValue | null>;
    try {
      values = await Promise.all(keys.map((key) => readAtom(this.redis, key, DhcpAtomValueSchema, { jobId })));
    } catch (error) {
      void this.logger.warning(`Failed to read DHCP config atoms — returning unavailable: ${getErrorMessage(error)}`, {
        jobId,
      });
      return { ok: false };
    }

    for (let i = 0; i < keys.length; i++) {
      const value = values[i];
      if (value === null) continue;

      const match = PREFIX_ID_PATTERN.exec(keys[i]);
      if (!match) {
        void this.logger.warning(`DHCP config atom key does not match expected pattern: ${keys[i]}`, { jobId });
        continue;
      }
      configs.set(match[1], value);
    }

    return { ok: true, configs };
  }

  /** Null on absent atom or read failure — callers keep their current runtime tuning. */
  async readZoneOps(jobId: string = ''): Promise<DhcpZoneOpsAtomValue | null> {
    try {
      return await readAtom(this.redis, dhcpZoneConfigKey(), DhcpZoneOpsAtomValueSchema, { jobId });
    } catch (error) {
      void this.logger.warning(
        `Failed to read DHCP zone ops atom — keeping current runtime tuning: ${getErrorMessage(error)}`,
        { jobId },
      );
      return null;
    }
  }
}
