import { DynamicModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { createLoggerProviders } from './logger.provider';
import { LoggerService } from './logger.service';

export class LoggerModule {
  static forRoot(): DynamicModule {
    const loggerProviders = createLoggerProviders();
    return {
      module: LoggerModule,
      global: true,
      imports: [ConfigModule],
      providers: [LoggerService, ...loggerProviders],
      exports: [LoggerService, ...loggerProviders],
    };
  }
}
