import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { REDIS_CLIENT } from 'src/common/redis';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { QualifyOrchestrationService } from '../lifecycle/qualify-orchestration.service';
import { DiscoveryOrchestratorService } from './discovery-orchestrator.service';
import { type DiscoveryCompleteData, REQUIRED_COLLECTORS, deviceDiscoveryCollectorKey } from './discovery.types';

@Injectable()
export class DiscoveryIngressService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly prisma: PrismaClient,
    private readonly orchestrator: DiscoveryOrchestratorService,
    private readonly qualifyOrchestration: QualifyOrchestrationService,
    @Logger(DiscoveryIngressService.name) private readonly logger: LoggerService,
  ) {}

  async handleDiscoveryComplete(data: DiscoveryCompleteData) {
    const { device_id: deviceId, zone_prefix: zonePrefix, fields, job_id: jobId } = data;

    if (fields.length === 0) {
      this.logger.warn(`Device ${deviceId}: discovery.complete with empty fields list (job=${jobId})`);
      return;
    }

    const keys = fields.map((field) => deviceDiscoveryCollectorKey(zonePrefix, deviceId, field));

    try {
      const values = await this.redis.mget(keys);

      const present = values.map((v, i) => [fields[i], v] as const).filter(([, v]) => v !== null && v !== undefined);

      if (present.length === 0) {
        this.logger.warn(
          `Device ${deviceId}: discovery.complete listed ${fields.length} fields but none found in Redis (job=${jobId})`,
        );
        await this.deleteKeys(keys);
        return;
      }

      const device = await this.prisma.device.findUnique({
        where: { id: deviceId, deletedAt: null },
        select: { id: true, zoneId: true },
      });
      if (!device) {
        this.logger.warn(`Device ${deviceId}: no live device row; discarding collector data`);
        await this.deleteKeys(keys);
        return;
      }

      if (device.zoneId !== zonePrefix) {
        this.logger.error(
          `Device ${deviceId}: discovery.complete zone mismatch (device zone=${device.zoneId}, message zone=${zonePrefix}); discarding`,
        );
        await this.deleteKeys(keys);
        return;
      }

      this.logger.log(
        `Device ${deviceId}: read ${present.length}/${fields.length} collector fields from Redis (job=${jobId})`,
      );

      const presentFields = new Set(present.map(([field]) => field));
      const missingRequired = REQUIRED_COLLECTORS.filter((req) => !presentFields.has(req));
      if (missingRequired.length > 0) {
        this.logger.warn(
          `Device ${deviceId}: missing required collectors: ${missingRequired.join(', ')} — processing anyway with available data`,
        );
      }

      const collectors: Record<string, unknown> = {};
      for (const [field, value] of present) {
        try {
          collectors[field] = JSON.parse(value as string);
        } catch {
          this.logger.warn(`Failed to parse collector '${field}' for device ${deviceId}`);
          collectors[field] = {};
        }
      }

      await this.orchestrator.runDiscovery({
        deviceId,
        zonePrefix,
        jobId,
        bundle: collectors,
        collectorCount: fields.length,
      });

      // Delete only after commit so failures keep the payload for retry; a del failure must not reach the outer catch (it would misclassify a committed run as failed) — stale keys are TTL'd by the bridge.
      try {
        await this.deleteKeys(keys);
      } catch (delError) {
        this.logger.warn(
          `Device ${deviceId}: discovery committed but failed to delete collector keys: ${getErrorMessage(delError)}`,
        );
      }
    } catch (error) {
      this.logger.error(`Discovery processing failed for device ${deviceId}: ${getErrorMessage(error)}`);
      try {
        const device = await this.prisma.device.findUnique({
          where: { id: deviceId, deletedAt: null },
          select: { id: true },
        });
        if (device) {
          await this.qualifyOrchestration.handleDiscoveryRunFailure(
            device.id,
            `Discovery processing failed: ${getErrorMessage(error)}`,
          );
        }
      } catch (error) {
        this.logger.warn(`Device ${deviceId}: failed to record discovery run failure: ${getErrorMessage(error)}`);
      }
    }
  }

  private async deleteKeys(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.redis.del(...keys);
  }
}
