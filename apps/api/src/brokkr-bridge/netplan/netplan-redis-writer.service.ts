import { Injectable } from '@nestjs/common';
import { Logger } from 'src/common/decorators/logger.decorator';
import {
  ConfigAtomWriter,
  NETPLAN_LIVE_TTL_SECONDS,
  netplanConfig,
  type AtomWriteResult,
  type NetplanPhase,
} from 'src/common/redis';
import { LoggerService } from 'src/logger/logger.service';
import { NetplanAtomSchema } from './netplan-atom.schema';

@Injectable()
export class NetplanRedisWriterService {
  constructor(
    private readonly atomWriter: ConfigAtomWriter,
    @Logger(NetplanRedisWriterService.name)
    private readonly logger: LoggerService,
  ) {}

  // MUST produce the identical key+shape+TTL envelope as the render-request dispatcher — a raw-YAML write fails the spoke's envelope parse and triggers render-on-miss every provision.
  async set(zonePrefix: string, deviceId: string, phase: NetplanPhase, yaml: string): Promise<AtomWriteResult> {
    const key = netplanConfig(deviceId, phase);
    const result = await this.atomWriter.writeAtomJson(
      zonePrefix,
      key,
      { yaml },
      NetplanAtomSchema,
      NETPLAN_LIVE_TTL_SECONDS,
      { request_id: null },
    );
    if (!result.written) {
      this.logger.log(`Skipped ${phase} netplan write (${result.reason}) for device ${deviceId} (key=${key})`);
      return result;
    }
    this.logger.log(`Wrote ${phase} netplan envelope for device ${deviceId} (key=${key})`);
    return result;
  }

  async deleteDeploy(zonePrefix: string, deviceId: string): Promise<void> {
    const key = netplanConfig(deviceId, 'deploy');
    await this.atomWriter.deleteKeys(zonePrefix, [key]);
    this.logger.log(`Deleted ${zonePrefix}:${key}`);
  }
}
