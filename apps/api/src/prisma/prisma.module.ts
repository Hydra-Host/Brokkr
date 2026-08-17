import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { macAddressExtension } from '@repo/database/extensions/mac-address';
import type { Queue } from 'bullmq';
import { DEVICE_STATUS_EFFECTS_QUEUE } from 'src/devices/device-status-effects/device-status-effects.types';
import { RedisPubSubService } from 'src/events/redis-pubsub.service';
import { LoggerService } from 'src/logger/logger.service';
import { createDeviceEffectsExtension } from './device-effects.extension';
import { PrismaClient } from './prisma.client';

const DEVICE_EFFECTS_LOGGER_TOKEN = 'LoggerServiceDeviceEffectsExtension';

@Global()
@Module({
  imports: [BullModule.registerQueue({ name: DEVICE_STATUS_EFFECTS_QUEUE })],
  providers: [
    {
      provide: DEVICE_EFFECTS_LOGGER_TOKEN,
      useFactory: (logger: LoggerService) => {
        logger.setContext('DeviceEffectsExtension');
        return logger;
      },
      inject: [LoggerService],
    },
    {
      provide: PrismaClient,
      useFactory: (
        configService: ConfigService,
        redisPubSub: RedisPubSubService,
        statusEffectsQueue: Queue,
        logger: LoggerService,
      ) => {
        const connectionString = configService.getOrThrow<string>('DATABASE_URL');
        const baseClient = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
        const extendedClient = baseClient
          .$extends(macAddressExtension)
          .$extends(createDeviceEffectsExtension({ redisPubSub, statusEffectsQueue, baseClient, logger }));
        return Object.assign(extendedClient, {
          onModuleInit: () => baseClient.$connect(),
          onModuleDestroy: () => baseClient.$disconnect(),
        });
      },
      inject: [
        ConfigService,
        RedisPubSubService,
        getQueueToken(DEVICE_STATUS_EFFECTS_QUEUE),
        DEVICE_EFFECTS_LOGGER_TOKEN,
      ],
    },
  ],
  exports: [PrismaClient],
})
export class PrismaModule {}
