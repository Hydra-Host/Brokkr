import { Injectable } from '@nestjs/common';
import { Logger } from 'src/common/decorators/logger.decorator';
import { ConfigAtomWriter, TTL_VRRP_VIP_SECONDS, vrrpConfig, type AtomWriteResult } from 'src/common/redis';
import { LoggerService } from 'src/logger/logger.service';
import { VrrpAtomSchema } from './vrrp-atom.schema';

@Injectable()
export class VrrpRedisWriterService {
  constructor(
    private readonly atomWriter: ConfigAtomWriter,
    @Logger(VrrpRedisWriterService.name)
    private readonly logger: LoggerService,
  ) {}

  async set(
    zoneId: string,
    prefixId: string,
    vip: string,
    ifaceByBridge: Record<string, string>,
    garpCount: number,
  ): Promise<AtomWriteResult> {
    const key = vrrpConfig(prefixId);
    const result = await this.atomWriter.writeAtomJson(
      zoneId,
      key,
      { vip, ifaceByBridge, garpCount },
      VrrpAtomSchema,
      TTL_VRRP_VIP_SECONDS,
      { request_id: null },
    );
    if (!result.written) {
      this.logger.log(`Skipped VRRP VIP write (${result.reason}) for prefix ${prefixId} (key=${key})`);
      return result;
    }
    const bridges = Object.keys(ifaceByBridge).join(', ');
    this.logger.log(`Wrote VRRP VIP envelope for prefix ${prefixId} (key=${key}, vip=${vip}, bridges=[${bridges}])`);
    return result;
  }

  async clear(zoneId: string, prefixId: string): Promise<void> {
    const key = vrrpConfig(prefixId);
    await this.atomWriter.delKey(zoneId, key);
    this.logger.log(`Cleared VRRP VIP for prefix ${prefixId} (key=${zoneId}:${key})`);
  }
}
