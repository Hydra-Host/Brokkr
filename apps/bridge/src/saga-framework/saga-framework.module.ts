import { DynamicModule, Module, Provider, type Type } from '@nestjs/common';

import type { RedisEncryptor } from '../common/redis/redis-client/redis-encryptor';
import { NotificationsService, ResultsQueueProducer, SagaLoggerLike } from './notifications.service';
import { PlanManagerConfig, PlanManagerService, RedisLike } from './plan-manager.service';
import { SagaRunnerService } from './saga-runner.service';

export interface SagaFrameworkModuleOptions {
  planManagerConfig: PlanManagerConfig;
  redis?: RedisLike;
  redisToken?: Type<unknown> | symbol | string;
  resultsQueueProducer?: ResultsQueueProducer | null;
  resultsQueueProducerToken?: Type<unknown> | symbol | string;
  logger?: SagaLoggerLike;
  encryptor?: RedisEncryptor;
}

@Module({})
export class SagaFrameworkModule {
  static forRoot(options: SagaFrameworkModuleOptions): DynamicModule {
    const planManagerProvider = buildPlanManagerProvider(options);
    const notificationsProvider: Provider =
      options.resultsQueueProducerToken !== undefined
        ? {
            provide: NotificationsService,
            useFactory: (producer: ResultsQueueProducer) => new NotificationsService(producer, options.logger),
            inject: [options.resultsQueueProducerToken],
          }
        : {
            provide: NotificationsService,
            useFactory: () => new NotificationsService(options.resultsQueueProducer ?? null, options.logger),
          };
    const sagaRunnerProvider: Provider = {
      provide: SagaRunnerService,
      useFactory: (planManager: PlanManagerService, notifications: NotificationsService) =>
        new SagaRunnerService(planManager, notifications, options.logger),
      inject: [PlanManagerService, NotificationsService],
    };
    return {
      module: SagaFrameworkModule,
      providers: [planManagerProvider, notificationsProvider, sagaRunnerProvider],
      exports: [PlanManagerService, NotificationsService, SagaRunnerService],
    };
  }
}

function buildPlanManagerProvider(options: SagaFrameworkModuleOptions): Provider {
  if (options.redisToken !== undefined) {
    return {
      provide: PlanManagerService,
      useFactory: (redis: RedisLike) =>
        new PlanManagerService(options.planManagerConfig, redis, options.logger, options.encryptor),
      inject: [options.redisToken],
    };
  }
  const redis = options.redis;
  if (redis === undefined) {
    throw new Error(
      'SagaFrameworkModule.forRoot requires `redis` or `redisToken`: PlanManagerService cannot run without Redis (silent in-memory degrade loses plans on restart)',
    );
  }
  return {
    provide: PlanManagerService,
    useFactory: () => new PlanManagerService(options.planManagerConfig, redis, options.logger, options.encryptor),
  };
}
