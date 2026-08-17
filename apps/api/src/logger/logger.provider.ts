import { Provider } from '@nestjs/common';
import { prefixesForLoggers } from 'src/common/decorators/logger.decorator';
import { LoggerService } from './logger.service';

function loggerFactory(logger: LoggerService, prefix: string) {
  if (prefix) {
    logger.setContext(prefix);
  }
  return logger;
}

function createLoggerProvider(prefix: string): Provider<LoggerService> {
  return {
    provide: `LoggerService${prefix}`,
    useFactory: (logger) => loggerFactory(logger, prefix),
    inject: [LoggerService],
  };
}

export function createLoggerProviders(): Array<Provider<LoggerService>> {
  return prefixesForLoggers.map((prefix) => createLoggerProvider(prefix));
}
