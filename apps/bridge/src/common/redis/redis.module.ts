import {
  type DynamicModule,
  Global,
  type InjectionToken,
  Module,
  type OptionalFactoryDependency,
  type Provider,
} from '@nestjs/common';

import type { RedisClientLogger, RedisConfig, RedisDriverFactory } from './redis-client';
import { REDIS_CONFIG, REDIS_DRIVER_FACTORY, REDIS_LOGGER, RedisService } from './redis.service';

export interface RedisModuleOptions {
  config: RedisConfig;
  driverFactory: RedisDriverFactory;
  logger?: RedisClientLogger;
}

export interface RedisModuleAsyncOptions {
  imports?: DynamicModule['imports'];
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
  useFactory: (...args: unknown[]) => Promise<RedisModuleOptions> | RedisModuleOptions;
}

@Global()
@Module({})
export class RedisModule {
  static forRoot(options: RedisModuleOptions): DynamicModule {
    const providers: Provider[] = [
      { provide: REDIS_CONFIG, useValue: options.config },
      { provide: REDIS_DRIVER_FACTORY, useValue: options.driverFactory },
      RedisService,
    ];
    if (options.logger !== undefined) {
      providers.push({ provide: REDIS_LOGGER, useValue: options.logger });
    }
    return {
      module: RedisModule,
      providers,
      exports: [RedisService, REDIS_CONFIG, REDIS_DRIVER_FACTORY, REDIS_LOGGER],
    };
  }

  static forRootAsync(options: RedisModuleAsyncOptions): DynamicModule {
    return {
      module: RedisModule,
      imports: options.imports,
      providers: [
        {
          provide: REDIS_CONFIG,
          inject: options.inject,
          useFactory: async (...args: unknown[]) => (await options.useFactory(...args)).config,
        },
        {
          provide: REDIS_DRIVER_FACTORY,
          inject: options.inject,
          useFactory: async (...args: unknown[]) => (await options.useFactory(...args)).driverFactory,
        },
        {
          provide: REDIS_LOGGER,
          inject: options.inject,
          useFactory: async (...args: unknown[]) => (await options.useFactory(...args)).logger,
        },
        RedisService,
      ],
      exports: [RedisService, REDIS_CONFIG, REDIS_DRIVER_FACTORY, REDIS_LOGGER],
    };
  }
}
