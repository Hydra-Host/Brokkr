import { DynamicModule, Global, Module } from '@nestjs/common';

import { createLoggerProviders } from './logger.provider';
import { ContextLogger } from './logger.service';

@Global()
@Module({
  providers: [ContextLogger],
  exports: [ContextLogger],
})
export class LoggerModule {
  static forRoot(): DynamicModule {
    const loggerProviders = createLoggerProviders();
    return {
      module: LoggerModule,
      global: true,
      providers: [ContextLogger, ...loggerProviders],
      exports: [ContextLogger, ...loggerProviders],
    };
  }
}
