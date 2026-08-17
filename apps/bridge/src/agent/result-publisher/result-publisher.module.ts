import { DynamicModule, Module, Provider, Type } from '@nestjs/common';

import { ResultPublisherRedis, ResultPublisherService } from './result-publisher.service';

export interface ResultPublisherModuleOptions {
  redisToken: Type<ResultPublisherRedis> | symbol | string;
  zonePrefix?: string;
}

@Module({})
export class ResultPublisherModule {
  static forRoot(options: ResultPublisherModuleOptions): DynamicModule {
    const provider: Provider = {
      provide: ResultPublisherService,
      useFactory: (redis: ResultPublisherRedis) => new ResultPublisherService(redis, options.zonePrefix ?? ''),
      inject: [options.redisToken],
    };
    return {
      module: ResultPublisherModule,
      providers: [provider],
      exports: [ResultPublisherService],
    };
  }
}
