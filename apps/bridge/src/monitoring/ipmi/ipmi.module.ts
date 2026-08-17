import { Logger, Module } from '@nestjs/common';

import { RedisModule } from '../../common/redis/redis.module';
import { RedisService } from '../../common/redis/redis.service';
import { getCipherForDevice } from '../../oob/ipmi/cipher';
import { createIpmiDevice, withCipher, type IPMIDevice } from '../../oob/ipmi/device';
import { executeBatch } from '../../oob/ipmi/handlers/batch';
import { executeMetricsCommand } from '../../oob/ipmi/handlers/metrics';
import { ipmiPing } from '../../oob/ipmi/ping';
import { validateIp, validateIpmiCommand, validatePort, validateUsername } from '../../oob/ipmi/validation';
import { MonitoringIpmiController } from './ipmi.controller';
import { IPMIMonitoringService, type IPMIDeviceLike, type IPMIMonitoringServiceDeps } from './ipmi.service';
import { IPMI_MONITORING_SERVICE_FACTORY, type IpmiMonitoringServiceFactory } from './ipmi.types';

function wrapDevice(device: IPMIDevice): IPMIDeviceLike {
  return {
    ip: device.ip,
    username: device.username,
    password: device.password,
    port: device.port,
    cipher: device.cipher,
    jobId: device.jobId,
    withCipher: (cipher: string | null): IPMIDeviceLike => wrapDevice(withCipher(device, cipher)),
  };
}

function buildDeps(redis: RedisService): IPMIMonitoringServiceDeps {
  const logger = new Logger('monitoring-ipmi-service');
  return {
    deviceFactory: {
      create: (args) => wrapDevice(createIpmiDevice(args)),
    },
    validators: {
      validateIp,
      validateUsername,
      validatePort,
      validateIpmiCommand,
    },
    ping: {
      ipmiPing: (ip, opts) => ipmiPing(ip, opts),
    },
    cipher: {
      getCipherForDevice: (device) => getCipherForDevice(redis.connection, device),
    },
    metrics: {
      executeMetricsCommand: (device, parts, opts) => executeMetricsCommand(device, parts, opts),
    },
    batch: {
      executeBatch: (device, commands) => executeBatch(device, commands),
    },
    logger: {
      debug: async (message, context) => {
        logger.debug(message, context?.jobId ?? '');
      },
      error: async (message, context) => {
        logger.error(message, context?.jobId ?? '');
      },
    },
  };
}

@Module({
  imports: [RedisModule],
  controllers: [MonitoringIpmiController],
  providers: [
    {
      provide: IPMI_MONITORING_SERVICE_FACTORY,
      inject: [RedisService],
      useFactory: (redis: RedisService): IpmiMonitoringServiceFactory => {
        const deps = buildDeps(redis);
        return {
          create: (jobId: string) => new IPMIMonitoringService(deps, jobId),
        };
      },
    },
  ],
  exports: [IPMI_MONITORING_SERVICE_FACTORY],
})
export class MonitoringIpmiModule {}
