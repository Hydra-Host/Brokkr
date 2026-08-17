import { Injectable } from '@nestjs/common';
import { Logger } from 'src/common/decorators/logger.decorator';
import {
  ConfigAtomWriter,
  DHCP_ZONE_CONFIG_KEY,
  TTL_DHCP_CONFIG_SECONDS,
  dhcpConfig,
  type AtomWriteResult,
} from 'src/common/redis';
import { LoggerService } from 'src/logger/logger.service';
import { DhcpAtomSchema, DhcpZoneOpsAtomSchema, type DhcpAtom, type DhcpZoneOpsAtom } from './dhcp-atom.schema';

// Key shape is a hub↔bridge wire contract: the bridge SCANs `{zoneUuid}:prefix:*:config:dhcp`.
@Injectable()
export class DhcpConfigRedisWriterService {
  constructor(
    private readonly atomWriter: ConfigAtomWriter,
    @Logger(DhcpConfigRedisWriterService.name)
    private readonly logger: LoggerService,
  ) {}

  async set(zoneId: string, prefixId: string, value: DhcpAtom): Promise<AtomWriteResult> {
    const key = dhcpConfig(prefixId);
    const result = await this.atomWriter.writeAtomJson(zoneId, key, value, DhcpAtomSchema, TTL_DHCP_CONFIG_SECONDS, {
      request_id: null,
    });
    if (!result.written) {
      this.logger.log(`Skipped DHCP config write (${result.reason}) for prefix ${prefixId} (key=${key})`);
      return result;
    }
    this.logger.log(
      `Wrote DHCP config envelope for prefix ${prefixId} (key=${key}, mode=${value.mode}, subnet=${value.subnet})`,
    );
    return result;
  }

  async clear(zoneId: string, prefixId: string): Promise<void> {
    const key = dhcpConfig(prefixId);
    await this.atomWriter.delKey(zoneId, key);
    this.logger.log(`Cleared DHCP config for prefix ${prefixId} (key=${zoneId}:${key})`);
  }

  async setZoneOps(zoneId: string, value: DhcpZoneOpsAtom): Promise<AtomWriteResult> {
    const result = await this.atomWriter.writeAtomJson(
      zoneId,
      DHCP_ZONE_CONFIG_KEY,
      value,
      DhcpZoneOpsAtomSchema,
      TTL_DHCP_CONFIG_SECONDS,
      { request_id: null },
    );
    if (!result.written) {
      this.logger.log(`Skipped DHCP zone ops write (${result.reason}) for zone ${zoneId}`);
      return result;
    }
    this.logger.log(`Wrote DHCP zone ops envelope for zone ${zoneId} (leaderPollMs=${value.leaderPollMs})`);
    return result;
  }

  async clearZoneOps(zoneId: string): Promise<void> {
    await this.atomWriter.delKey(zoneId, DHCP_ZONE_CONFIG_KEY);
    this.logger.log(`Cleared DHCP zone ops for zone ${zoneId}`);
  }
}
