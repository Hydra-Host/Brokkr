import { Module, type OnModuleInit } from '@nestjs/common';

import { BrokkrLiveModule } from '../brokkr-live/brokkr-live.module';
import { BrokkrLiveServiceFactory } from '../brokkr-live/brokkr-live.service';
import { getBullmqConfig } from '../bullmq/bullmq.config';
import { BullmqQueueService } from '../bullmq/queue.service';
import { RedisService } from '../common/redis/redis.service';
import {
  createDeviceHealthService,
  type IcmpServiceFactory as DeviceHealthIcmpFactory,
  type ResultsQueueLike,
} from '../monitoring/device-health/device-health.service';
import { MonitoringIcmpModule } from '../monitoring/icmp/icmp.module';
import { ICMP_SERVICE_FACTORY, type IcmpServiceFactory as IcmpModuleFactory } from '../monitoring/icmp/icmp.types';
import { registerSagaDef } from '../saga-framework/saga-registry';

import { buildDeviceHealthCheckSaga } from './device-health-check.workflow';
import { CheckDeviceHealthStep } from './steps/check-device-health.step';

function adaptIcmpFactory(factory: IcmpModuleFactory): DeviceHealthIcmpFactory {
  return {
    create: (jobId: string) => {
      const svc = factory.create(jobId);
      return {
        executePingTest: async (args) => {
          const res = await svc.executePingTest({
            ip: args.ip,
            count: args.count,
            timeout: args.timeout,
            packetSize: 56,
            interval: 1,
            extendedMetrics: false,
          });
          const out: Record<string, unknown> = Object.fromEntries(Object.entries(res));
          if (typeof out.metrics === 'object' && out.metrics !== null) {
            out.metrics = Object.fromEntries(Object.entries(out.metrics));
          }
          return out;
        },
      };
    },
  };
}

function adaptResultsQueueProvider(svc: BullmqQueueService): { get: () => Promise<ResultsQueueLike | null> } {
  return {
    get: async () => {
      const queue = await svc.getResultsQueue();
      if (queue === null) return null;
      return {
        add: (name, payload, opts) => {
          const removeOnComplete = isCountRecord(opts.removeOnComplete) ? opts.removeOnComplete : { count: 1000 };
          const removeOnFail = isCountRecord(opts.removeOnFail) ? opts.removeOnFail : { count: 100 };
          return queue.add(name, payload as Record<string, unknown>, {
            jobId: typeof opts.jobId === 'string' ? opts.jobId : `${name}-${Date.now()}`,
            attempts: typeof opts.attempts === 'number' ? opts.attempts : 1,
            backoff: isBackoffRecord(opts.backoff) ? opts.backoff : { type: 'fixed', delay: 1000 },
            removeOnComplete,
            removeOnFail,
          });
        },
      };
    },
  };
}

function isCountRecord(value: unknown): value is { count: number } {
  return typeof value === 'object' && value !== null && typeof (value as { count?: unknown }).count === 'number';
}

function isBackoffRecord(value: unknown): value is { type: string; delay: number } {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { type?: unknown; delay?: unknown };
  return typeof v.type === 'string' && typeof v.delay === 'number';
}

@Module({
  imports: [BrokkrLiveModule, MonitoringIcmpModule],
  providers: [
    {
      provide: CheckDeviceHealthStep,
      useFactory: (
        icmpFactory: IcmpModuleFactory,
        brokkrLiveFactory: BrokkrLiveServiceFactory,
        redisService: RedisService,
        bullmqQueueService: BullmqQueueService,
      ) =>
        new CheckDeviceHealthStep({
          create: async (jobId: string) => {
            const svc = await createDeviceHealthService(jobId, {
              icmpFactory: adaptIcmpFactory(icmpFactory),
              brokkrLiveFactory,
              resultsRedis: { get: async () => redisService.connection },
              resultsQueue: adaptResultsQueueProvider(bullmqQueueService),
              jobStorage: { getBullmqPrefix: () => getBullmqConfig().bullmqPrefix },
            });
            return {
              checkDeviceHealth: async (args) => {
                const result = await svc.checkDeviceHealth({
                  deviceId: args.deviceId,
                  bmcIp: typeof args.bmcIp === 'string' ? args.bmcIp : null,
                  primaryIp: typeof args.primaryIp === 'string' ? args.primaryIp : null,
                  username: typeof args.username === 'string' ? args.username : '',
                  password: typeof args.password === 'string' ? args.password : '',
                });
                const out: Record<string, unknown> = {};
                for (const [k, v] of Object.entries(result)) out[k] = v;
                return out;
              },
            };
          },
        }),
      inject: [ICMP_SERVICE_FACTORY, BrokkrLiveServiceFactory, RedisService, BullmqQueueService],
    },
  ],
  exports: [CheckDeviceHealthStep],
})
export class DeviceHealthCheckModule implements OnModuleInit {
  constructor(private readonly checkDevice: CheckDeviceHealthStep) {}

  onModuleInit(): void {
    registerSagaDef(buildDeviceHealthCheckSaga({ checkDevice: this.checkDevice }));
  }
}
