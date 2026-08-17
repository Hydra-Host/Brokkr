import { DynamicModule, Module, Provider, Type } from '@nestjs/common';

import type { AtomCache, EnqueueRenderRequest } from './atom/atom-fetcher';
import {
  DEVICE_RECORD_CACHE,
  DEVICE_RECORD_LOGGER,
  DEVICE_RECORD_RENDER_ENQUEUER,
  DeviceRecordService,
  type DeviceRecordLogger,
} from './device-record.service';

export interface DeviceRecordModuleOptions {
  cache?: AtomCache;
  cacheToken?: Type<AtomCache> | symbol | string;
  enqueueRenderRequest?: EnqueueRenderRequest;
  enqueueRenderRequestToken?: Type<unknown> | symbol | string;
  logger?: DeviceRecordLogger;
}

@Module({})
export class DeviceRecordModule {
  static forRoot(options: DeviceRecordModuleOptions): DynamicModule {
    if (options.enqueueRenderRequest === undefined && options.enqueueRenderRequestToken === undefined) {
      throw new Error(
        'DeviceRecordModule.forRoot: exactly one of `enqueueRenderRequest` (value) or `enqueueRenderRequestToken` (DI token) must be supplied',
      );
    }
    if (options.cache === undefined && options.cacheToken === undefined) {
      throw new Error(
        'DeviceRecordModule.forRoot: exactly one of `cache` (value) or `cacheToken` (DI token) must be supplied',
      );
    }

    const enqueuerProvider: Provider =
      options.enqueueRenderRequestToken !== undefined
        ? {
            provide: DEVICE_RECORD_RENDER_ENQUEUER,
            useFactory: (enqueuer: EnqueueRenderRequest) => enqueuer,
            inject: [options.enqueueRenderRequestToken],
          }
        : {
            provide: DEVICE_RECORD_RENDER_ENQUEUER,
            useValue: options.enqueueRenderRequest as EnqueueRenderRequest,
          };

    const cacheProvider: Provider =
      options.cacheToken !== undefined
        ? {
            provide: DEVICE_RECORD_CACHE,
            useFactory: (cache: AtomCache) => cache,
            inject: [options.cacheToken],
          }
        : {
            provide: DEVICE_RECORD_CACHE,
            useValue: options.cache as AtomCache,
          };

    const providers: Provider[] = [
      cacheProvider,
      enqueuerProvider,
      ...(options.logger ? [{ provide: DEVICE_RECORD_LOGGER, useValue: options.logger } satisfies Provider] : []),
      DeviceRecordService,
    ];
    return {
      module: DeviceRecordModule,
      providers,
      exports: [DeviceRecordService],
    };
  }
}
