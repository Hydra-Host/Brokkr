import {
  ConsoleLogger,
  Injectable,
  LogLevel,
  LoggerService as NestJSLoggerService,
  OnModuleDestroy,
  Scope,
} from '@nestjs/common';
import { emitTelemetryLog, type TelemetryLogLevel } from '@repo/telemetry';
import { ContextService } from 'src/common/context/context.service';
import { getLogLevels } from './log-levels';

@Injectable({
  scope: Scope.TRANSIENT,
})
export class LoggerService extends ConsoleLogger implements NestJSLoggerService, OnModuleDestroy {
  private readonly logLevels: LogLevel[];

  constructor(private readonly contextService: ContextService) {
    super('BrokkrLogger');
    this.logLevels = getLogLevels();
  }

  setContext(context: string): this {
    super.setContext(context);
    return this;
  }

  private shouldLog(level: LogLevel): boolean {
    return this.logLevels.includes(level);
  }

  private withCorrelation(message: string, jobId?: string): string {
    const correlationId = jobId || this.contextService.requestId;
    return correlationId ? `[${correlationId}] ${message}` : message;
  }

  private forward(level: TelemetryLogLevel, message: string, jobId?: string, trace?: string): void {
    emitTelemetryLog('brokkr-hub', level, message, {
      'brokkr.logger_context': this.context,
      'brokkr.correlation_id': jobId || this.contextService.requestId,
      'exception.stacktrace': trace,
    });
  }

  log(message: string, jobId?: string): void {
    if (!this.shouldLog('log')) return;
    super.log(this.withCorrelation(message, jobId), this.context);
    this.forward('info', message, jobId);
  }

  error(message: string, trace?: string, jobId?: string): void {
    if (!this.shouldLog('error')) return;
    super.error(this.withCorrelation(message, jobId), trace, this.context);
    this.forward('error', message, jobId, trace);
  }

  warn(message: string, jobId?: string): void {
    if (!this.shouldLog('warn')) return;
    super.warn(this.withCorrelation(message, jobId), this.context);
    this.forward('warn', message, jobId);
  }

  debug(message: string, jobId?: string): void {
    if (!this.shouldLog('debug')) return;
    super.debug(this.withCorrelation(message, jobId), this.context);
    this.forward('debug', message, jobId);
  }

  verbose(message: string, jobId?: string): void {
    if (!this.shouldLog('verbose')) return;
    super.verbose(this.withCorrelation(message, jobId), this.context);
    this.forward('verbose', message, jobId);
  }

  async onModuleDestroy(): Promise<void> {
    super.log('Logger module destroyed', this.context ?? 'BrokkrLogger');
  }
}
