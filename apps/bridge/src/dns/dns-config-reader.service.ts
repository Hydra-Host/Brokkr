import { getErrorMessage } from '../common/error-utils';
import { dnsPrefixConfigScanPattern, dnsZoneConfigKey } from '../common/redis/redis-keys';
import { readAtom } from '../device-record/atom/atom-fetcher';
import type { AtomReaderRedis } from '../dhcp/dhcp-config-reader.service';
import type { ContextLogger } from '../logger/logger.service';

import {
  DnsConfigAtomValueSchema,
  DnsPrefixOverrideAtomValueSchema,
  type DnsConfigAtomValue,
  type DnsPrefixOverrideAtomValue,
} from './dns-atom-value.schema';

export type DnsZoneConfigReadResult =
  | { ok: true; config: DnsConfigAtomValue; reason?: undefined }
  | { ok: false; config?: undefined; reason: 'missing' | 'error' };

export type DnsPrefixOverrideReadResult =
  | { ok: true; overrides: Map<string, DnsPrefixOverrideAtomValue> }
  | { ok: false };

const PREFIX_ID_PATTERN = /^prefix:([^:]+):config:dns$/;

export class DnsConfigReaderService {
  constructor(
    private readonly redis: AtomReaderRedis,
    private readonly logger: ContextLogger,
  ) {}

  async readZoneConfig(jobId: string = ''): Promise<DnsZoneConfigReadResult> {
    let value: DnsConfigAtomValue | null;
    try {
      value = await readAtom(this.redis, dnsZoneConfigKey(), DnsConfigAtomValueSchema, { jobId });
    } catch (error) {
      void this.logger.warning(
        `Failed to read DNS zone config atom — returning unavailable: ${getErrorMessage(error)}`,
        { jobId },
      );
      return { ok: false, reason: 'error' };
    }

    if (value === null) {
      return { ok: false, reason: 'missing' };
    }

    return { ok: true, config: value };
  }

  async readPrefixOverrides(jobId: string = ''): Promise<DnsPrefixOverrideReadResult> {
    let keys: string[];
    try {
      keys = await this.redis.scan(dnsPrefixConfigScanPattern(), jobId);
    } catch (error) {
      void this.logger.warning(
        `Failed to SCAN DNS prefix override atoms — returning unavailable: ${getErrorMessage(error)}`,
        { jobId },
      );
      return { ok: false };
    }

    const overrides = new Map<string, DnsPrefixOverrideAtomValue>();

    let values: Array<DnsPrefixOverrideAtomValue | null>;
    try {
      values = await Promise.all(
        keys.map((key) => readAtom(this.redis, key, DnsPrefixOverrideAtomValueSchema, { jobId })),
      );
    } catch (error) {
      void this.logger.warning(
        `Failed to read DNS prefix override atoms — returning unavailable: ${getErrorMessage(error)}`,
        { jobId },
      );
      return { ok: false };
    }

    for (let i = 0; i < keys.length; i++) {
      const value = values[i];
      if (value === null) continue;

      const match = PREFIX_ID_PATTERN.exec(keys[i]);
      if (!match) {
        void this.logger.warning(`DNS prefix override atom key does not match expected pattern: ${keys[i]}`, { jobId });
        continue;
      }
      overrides.set(match[1], value);
    }

    return { ok: true, overrides };
  }
}
