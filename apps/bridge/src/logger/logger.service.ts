import { Inject, Injectable, Optional } from '@nestjs/common';
import { emitTelemetryLog } from '@repo/telemetry';

import { JobIdPrefixFilter, type JobIdPrefixFilterInput } from './context/job-id-prefix-filter';
import {
  getJobId as getContextJobId,
  isPlanShapedJobId,
  setJobIdInCurrentContext,
  shouldPropagateJobId,
} from './context/job-id.context';
import { parseSuppressJobIdPrefixes } from './context/suppress-prefixes';
import { getJobLogSink } from './job-log-sink-registry';
import { NUMERIC_LEVELS, resolveLogLevel, type LogLevel } from './log-levels';

export { resolveLogLevel } from './log-levels';
export type { LogLevel } from './log-levels';

const LEVEL_NAME_UPPER: Record<LogLevel, string> = {
  debug: 'DEBUG',
  info: 'INFO',
  warning: 'WARNING',
  error: 'ERROR',
};

export interface LogContext {
  jobId?: string;
  appClassName?: string;
  appName?: string;
  deviceId?: string;
  traceId?: string;
  spanId?: string;
}

export interface LogRecord {
  level: LogLevel;
  message: string;
  jobId: string;
  appClassName: string;
  appName: string;
}

export interface LogFormatter {
  format(record: LogRecord): string;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function pad3(n: number): string {
  if (n < 10) return `00${n}`;
  if (n < 100) return `0${n}`;
  return String(n);
}

function formatUtcTimestamp(d: Date): string {
  const y = d.getUTCFullYear();
  const m = pad2(d.getUTCMonth() + 1);
  const day = pad2(d.getUTCDate());
  const hh = pad2(d.getUTCHours());
  const mm = pad2(d.getUTCMinutes());
  const ss = pad2(d.getUTCSeconds());
  const ms = d.getUTCMilliseconds();
  const frac = ms === 0 ? '' : `.${pad3(ms)}000`;
  return `${y}-${m}-${day}T${hh}:${mm}:${ss}${frac}+00:00`;
}

function jsonSerialize(entry: Record<string, string>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(entry)) {
    parts.push(`${JSON.stringify(key)}: ${JSON.stringify(value)}`);
  }
  return `{${parts.join(', ')}}`;
}

export class BridgeJsonFormatter implements LogFormatter {
  format(record: LogRecord): string {
    const entry: Record<string, string> = {
      app_name: record.appName,
      app_class_name: record.appClassName,
      job_id: String(record.jobId),
      log_level: record.level,
      message: record.message,
      timestamp: formatUtcTimestamp(new Date()),
    };
    return jsonSerialize(entry);
  }
}

const LEVEL_WIDTH = 7;
const LEVEL_COLORS: Record<string, string> = {
  DEBUG: '\x1b[95m',
  INFO: '\x1b[32m',
  WARNING: '\x1b[33m',
  ERROR: '\x1b[31m',
  CRITICAL: '\x1b[31m',
};
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const FG_RESET = '\x1b[39m';
const RESET = '\x1b[0m';

function formatConsoleTimestamp(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yyyy = d.getFullYear();
  const h24 = d.getHours();
  const period = h24 >= 12 ? 'PM' : 'AM';
  let h12 = h24 % 12;
  if (h12 === 0) h12 = 12;
  const hh = String(h12).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${mm}/${dd}/${yyyy}, ${hh}:${mi}:${ss} ${period}`;
}

export class BridgeConsoleFormatter implements LogFormatter {
  private readonly useColor: boolean;

  constructor(options?: { useColor?: boolean; env?: NodeJS.ProcessEnv }) {
    const env = options?.env ?? process.env;
    this.useColor = options?.useColor ?? env.NO_COLOR === undefined;
  }

  format(record: LogRecord): string {
    const ts = formatConsoleTimestamp(new Date());
    const levelName = LEVEL_NAME_UPPER[record.level];
    const level = levelName.padStart(LEVEL_WIDTH, ' ');
    const jobId = record.jobId;

    if (!this.useColor) {
      const suffix = jobId ? `  (job=${jobId})` : '';
      return `[${record.appName}] ${ts}  ${level} [${record.appClassName}] ${record.message}${suffix}`;
    }

    const lc = LEVEL_COLORS[levelName] ?? '';
    const nameC = `${GREEN}[${record.appName}]${FG_RESET}`;
    const levelC = `${lc}${level}${FG_RESET}`;
    const ctxC = `${YELLOW}[${record.appClassName}]${FG_RESET}`;
    const msgC = `${lc}${record.message}${FG_RESET}`;
    const suffix = jobId ? `  ${DIM}(job=${jobId})${RESET}` : '';
    return `${nameC} ${ts}  ${levelC} ${ctxC} ${msgC}${suffix}`;
  }
}

export function resolveFormatter(env: NodeJS.ProcessEnv = process.env): LogFormatter {
  if ((env.LOG_FORMAT ?? 'json').toLowerCase() === 'console') {
    return new BridgeConsoleFormatter({ env });
  }
  return new BridgeJsonFormatter();
}

export function getSuppressedJobIdPrefixes(env: NodeJS.ProcessEnv = process.env): string[] {
  return parseSuppressJobIdPrefixes(env.LOG_SUPPRESS_JOB_ID_PREFIXES);
}

interface Writable {
  write(chunk: string): unknown;
  flush?(): unknown;
}

abstract class BridgeHandlerBase {
  protected readonly stream: Writable;
  protected formatter: LogFormatter;
  protected filter: JobIdPrefixFilter | null = null;
  protected level: number = NUMERIC_LEVELS.info;
  protected lastDedupKey: string | null = null;
  protected lastTimestamp: number | null = null;

  constructor(stream: Writable, formatter: LogFormatter) {
    this.stream = stream;
    this.formatter = formatter;
  }

  setFormatter(formatter: LogFormatter): void {
    this.formatter = formatter;
  }

  setFilter(filter: JobIdPrefixFilter | null): void {
    this.filter = filter;
  }

  setLevel(level: LogLevel): void {
    this.level = NUMERIC_LEVELS[level];
  }

  protected runFilter(record: LogRecord): boolean {
    if (!this.filter) return true;
    const input: JobIdPrefixFilterInput = { jobId: record.jobId };
    return this.filter.accept(input);
  }

  protected shouldDedup(record: LogRecord): boolean {
    // Key deliberately excludes the formatter's wall-clock timestamp so identical messages
    // in rapid succession always hash to the same key.
    const key = JSON.stringify([record.level, record.message, record.jobId, record.appClassName, record.appName]);
    const now = (performance.timeOrigin + performance.now()) / 1000;
    if (this.lastDedupKey === key && this.lastTimestamp !== null && now - this.lastTimestamp < 0.1) {
      return true;
    }
    this.lastDedupKey = key;
    this.lastTimestamp = now;
    return false;
  }
}

// `flush?.()` is deliberate — real Node streams don't expose `.flush`.
export class BridgeSyncHandler extends BridgeHandlerBase {
  constructor(stream: Writable = process.stdout, formatter: LogFormatter = new BridgeJsonFormatter()) {
    super(stream, formatter);
  }

  emit(record: LogRecord): void {
    try {
      if (!this.runFilter(record)) return;
      if (this.shouldDedup(record)) return;
      const msg = this.formatter.format(record);
      this.stream.write(msg + '\n');
      this.stream.flush?.();
    } catch (error) {
      void error;
    }
  }
}

export class BridgeAsyncHandler extends BridgeHandlerBase {
  constructor(stream: Writable = process.stdout, formatter: LogFormatter = new BridgeJsonFormatter()) {
    super(stream, formatter);
  }

  async emitAsync(record: LogRecord): Promise<boolean> {
    try {
      if (!this.runFilter(record)) return false;
      if (this.shouldDedup(record)) return false;
      const msg = this.formatter.format(record);
      await Promise.resolve(this.stream.write(msg + '\n'));
      await Promise.resolve(this.stream.flush?.());
    } catch (error) {
      void error;
    }
    return true;
  }
}

export interface MonitoringLogGate {
  shouldSkip(): boolean;
}

export const MONITORING_LOG_GATE = Symbol('MONITORING_LOG_GATE');

const MONITORING_PATH_PREFIXES = ['/api/ping', '/api/ipmi/metrics', '/api/ipmi/batch-metrics', '/api/monitoring/'];

export function isMonitoringPath(path: string): boolean {
  for (const prefix of MONITORING_PATH_PREFIXES) {
    if (path.startsWith(prefix)) return true;
  }
  return false;
}

@Injectable()
export class ContextLogger {
  private readonly handler: BridgeAsyncHandler;
  private readonly env: NodeJS.ProcessEnv;
  private readonly level: LogLevel;
  private readonly jobIdFilter: JobIdPrefixFilter;

  constructor(
    @Optional() @Inject(MONITORING_LOG_GATE) private readonly monitoringGate: MonitoringLogGate | null = null,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.env = env;
    this.level = resolveLogLevel(env);
    this.jobIdFilter = new JobIdPrefixFilter(getSuppressedJobIdPrefixes(env));
    this.handler = new BridgeAsyncHandler(process.stdout, resolveFormatter(env));
    this.handler.setLevel(this.level);
    this.handler.setFilter(this.jobIdFilter);
  }

  getJobId(provided?: string | null): string {
    if (provided) return provided;
    const ctx = getContextJobId();
    if (ctx) return ctx;
    return '';
  }

  shouldSkipMonitoringLog(): boolean {
    return this.monitoringGate?.shouldSkip() ?? false;
  }

  async log(level: LogLevel, message: string, context: LogContext = {}): Promise<void> {
    const jobId = this.getJobId(context.jobId);
    if (this.shouldSkipMonitoringLog()) return;

    const propagateJobId = shouldPropagateJobId(jobId);
    if (propagateJobId) {
      setJobIdInCurrentContext(jobId);
    }

    if (propagateJobId && isPlanShapedJobId(jobId) && this.jobIdFilter.accept({ jobId })) {
      getJobLogSink()?.enqueue(jobId, {
        timestamp: formatUtcTimestamp(new Date()),
        log_level: level,
        message,
        app_name: context.appName || 'bridge-api',
        app_class_name: context.appClassName || 'unknown',
      });
    }

    if (NUMERIC_LEVELS[level] < NUMERIC_LEVELS[this.level]) return;

    const record: LogRecord = {
      level,
      message,
      jobId,
      appClassName: context.appClassName || 'unknown',
      appName: context.appName || 'bridge-api',
    };
    const emitted = await this.handler.emitAsync(record);
    if (emitted) {
      emitTelemetryLog(
        'brokkr-bridge',
        level === 'warning' ? 'warn' : level,
        message,
        {
          'brokkr.app_class_name': record.appClassName,
          'brokkr.job_id': jobId || undefined,
          'brokkr.app_name': record.appName,
          'brokkr.device_id': context.deviceId,
        },
        context.traceId !== undefined && context.spanId !== undefined
          ? { traceId: context.traceId, spanId: context.spanId }
          : undefined,
      );
    }
  }

  info(message: string, context?: LogContext): Promise<void> {
    return this.log('info', message, context);
  }
  warning(message: string, context?: LogContext): Promise<void> {
    return this.log('warning', message, context);
  }
  error(message: string, context?: LogContext): Promise<void> {
    return this.log('error', message, context);
  }
  debug(message: string, context?: LogContext): Promise<void> {
    return this.log('debug', message, context);
  }
}

export interface LoggerLike {
  debug(message: string, context?: LogContext): Promise<void>;
  info(message: string, context?: LogContext): Promise<void>;
  warning(message: string, context?: LogContext): Promise<void>;
  error(message: string, context?: LogContext): Promise<void>;
}

let singleton: ContextLogger | null = null;

export function getLogger(): ContextLogger {
  if (singleton === null) {
    singleton = new ContextLogger();
  }
  return singleton;
}

export function resetLoggerForTests(): void {
  singleton = null;
}

export async function logInfo(message: string, context?: LogContext): Promise<void> {
  await getLogger().info(message, context);
}

export async function logWarning(message: string, context?: LogContext): Promise<void> {
  await getLogger().warning(message, context);
}

export async function logError(message: string, context?: LogContext): Promise<void> {
  await getLogger().error(message, context);
}

export async function logDebug(message: string, context?: LogContext): Promise<void> {
  await getLogger().debug(message, context);
}
