import { Inject, Provider } from '@nestjs/common';

import { ContextLogger, type LogContext, type LoggerLike } from './logger.service';

const LOGGER_TOKEN_PREFIX = 'BridgeLogger:';

export const loggerTokenFor = (name: string): string => `${LOGGER_TOKEN_PREFIX}${name}`;

export const registeredLoggerNames: string[] = [];

export function Logger(name: string = ''): ParameterDecorator {
  if (!registeredLoggerNames.includes(name)) {
    registeredLoggerNames.push(name);
  }
  return Inject(loggerTokenFor(name));
}

class PrefixedLogger implements LoggerLike {
  constructor(
    private readonly delegate: ContextLogger,
    private readonly appClassName: string,
  ) {}

  private merge(context?: LogContext): LogContext {
    if (!context) return { appClassName: this.appClassName };
    return { ...context, appClassName: context.appClassName ?? this.appClassName };
  }

  debug(message: string, context?: LogContext): Promise<void> {
    return this.delegate.debug(message, this.merge(context));
  }

  info(message: string, context?: LogContext): Promise<void> {
    return this.delegate.info(message, this.merge(context));
  }

  warning(message: string, context?: LogContext): Promise<void> {
    return this.delegate.warning(message, this.merge(context));
  }

  error(message: string, context?: LogContext): Promise<void> {
    return this.delegate.error(message, this.merge(context));
  }
}

function createLoggerProvider(name: string): Provider {
  return {
    provide: loggerTokenFor(name),
    useFactory: (logger: ContextLogger) => new PrefixedLogger(logger, name || 'unknown'),
    inject: [ContextLogger],
  };
}

export function createLoggerProviders(): Provider[] {
  return registeredLoggerNames.map(createLoggerProvider);
}
