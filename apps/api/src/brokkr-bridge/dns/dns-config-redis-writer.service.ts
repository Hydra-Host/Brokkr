import { Injectable } from '@nestjs/common';
import { Logger } from 'src/common/decorators/logger.decorator';
import {
  ConfigAtomWriter,
  DNS_CONFIG_KEY,
  TTL_DNS_CONFIG_SECONDS,
  dnsPrefixConfig,
  type AtomWriteResult,
} from 'src/common/redis';
import { LoggerService } from 'src/logger/logger.service';
import {
  DnsConfigAtomSchema,
  DnsPrefixOverrideAtomSchema,
  type DnsConfigAtom,
  type DnsPrefixOverrideAtom,
} from './dns-atom.schema';

@Injectable()
export class DnsConfigRedisWriterService {
  constructor(
    private readonly atomWriter: ConfigAtomWriter,
    @Logger(DnsConfigRedisWriterService.name)
    private readonly logger: LoggerService,
  ) {}

  async setZone(zoneId: string, value: DnsConfigAtom): Promise<AtomWriteResult> {
    const result = await this.atomWriter.writeAtomJson(
      zoneId,
      DNS_CONFIG_KEY,
      value,
      DnsConfigAtomSchema,
      TTL_DNS_CONFIG_SECONDS,
      { request_id: null },
    );
    if (!result.written) {
      this.logger.log(`Skipped DNS zone config write (${result.reason}) for zone ${zoneId}`);
      return result;
    }
    this.logger.log(`Wrote DNS zone config envelope for zone ${zoneId} (enabled=${value.enabled})`);
    return result;
  }

  async clearZone(zoneId: string): Promise<void> {
    await this.atomWriter.delKey(zoneId, DNS_CONFIG_KEY);
    this.logger.log(`Cleared DNS zone config for zone ${zoneId}`);
  }

  async setPrefix(zoneId: string, prefixId: string, value: DnsPrefixOverrideAtom): Promise<AtomWriteResult> {
    const key = dnsPrefixConfig(prefixId);
    const result = await this.atomWriter.writeAtomJson(
      zoneId,
      key,
      value,
      DnsPrefixOverrideAtomSchema,
      TTL_DNS_CONFIG_SECONDS,
      { request_id: null },
    );
    if (!result.written) {
      this.logger.log(`Skipped DNS prefix config write (${result.reason}) for prefix ${prefixId}`);
      return result;
    }
    this.logger.log(`Wrote DNS prefix override envelope for prefix ${prefixId} (serveDns=${value.serveDns})`);
    return result;
  }

  async clearPrefix(zoneId: string, prefixId: string): Promise<void> {
    const key = dnsPrefixConfig(prefixId);
    await this.atomWriter.delKey(zoneId, key);
    this.logger.log(`Cleared DNS prefix override for prefix ${prefixId}`);
  }
}
