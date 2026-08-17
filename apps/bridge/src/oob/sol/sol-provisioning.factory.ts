import { Injectable } from '@nestjs/common';

import { RedisService } from '../../common/redis/redis.service.js';
import { ContextLogger } from '../../logger/logger.service.js';
import { getCipherForDevice } from '../ipmi/cipher.js';
import { buildBaseCommand } from '../ipmi/command.js';
import {
  solInfo as adapterSolInfo,
  solPayloadEnable as adapterSolPayloadEnable,
  solPayloadStatus as adapterSolPayloadStatus,
  solSetEnabled as adapterSolSetEnabled,
} from '../ipmi/handlers/sol.js';
import { run as adapterTransportRun } from '../ipmi/transport.js';
import {
  type SolProvisioningCache,
  type SolProvisioningDeps,
  SolProvisioningService,
} from './sol-provisioning.service.js';

@Injectable()
export class SolProvisioningServiceFactory {
  constructor(
    private readonly redis: RedisService,
    private readonly logger: ContextLogger,
  ) {}

  async create(jobId: string): Promise<SolProvisioningService> {
    const deps = this.buildDeps();
    return new SolProvisioningService(jobId, deps);
  }

  private buildDeps(): SolProvisioningDeps {
    const redisClient = this.redis.connection;

    const cache: SolProvisioningCache = {
      get: (key, jobId) => redisClient.get(key, jobId),
      set: (key, value, ttl, jobId) => redisClient.set(key, value, ttl ?? undefined, jobId),
      delete: (key, jobId) => redisClient.delete(key, jobId),
    };

    return {
      cache,
      buildBaseCommand: (device) => buildBaseCommand(device),
      transport: (command, password, timeout, opts) =>
        adapterTransportRun(command, password, timeout, {
          cipherUsed: opts.cipherUsed ?? null,
          jobId: opts.jobId ?? '',
        }),
      getCipher: (device, deviceId) => getCipherForDevice(redisClient, device, deviceId ?? null),
      handlers: {
        solInfo: (device, channel, opts) => adapterSolInfo(device, channel, opts),
        solSetEnabled: (device, enabled, channel, opts) => adapterSolSetEnabled(device, enabled, channel, opts),
        solPayloadStatus: (device, channel, userId, opts) => adapterSolPayloadStatus(device, channel, userId, opts),
        solPayloadEnable: (device, channel, userId, opts) => adapterSolPayloadEnable(device, channel, userId, opts),
      },
      logger: this.logger,
    };
  }
}
