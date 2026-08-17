import { emitTelemetryLog } from '@repo/telemetry';
import { getApplicationConfig, type ApplicationConfig } from '../application.config.js';

export type LogLevel = 'debug' | 'info' | 'warning' | 'error';

export interface LogOptions {
  jobId?: string;
  appClassName?: string;
  appName?: string;
}

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warning: 30,
  error: 40,
};

interface ResolvedLoggerConfig {
  readonly minLevel: number;
  readonly format: 'json' | 'console';
  readonly suppressJobIdPrefixes: readonly string[];
}

let cached: ResolvedLoggerConfig | null = null;

function resolveLoggerConfig(): ResolvedLoggerConfig {
  if (cached !== null) return cached;
  let appCfg: ApplicationConfig | null;
  try {
    appCfg = getApplicationConfig();
  } catch {
    appCfg = null;
  }
  const rawLevel = (appCfg?.logLevel ?? 'info').toLowerCase();
  const level: LogLevel = rawLevel === 'debug' || rawLevel === 'warning' || rawLevel === 'error' ? rawLevel : 'info';
  const rawFormat = (appCfg?.logFormat ?? 'json').toLowerCase();
  const format: 'json' | 'console' = rawFormat === 'console' ? 'console' : 'json';
  cached = {
    minLevel: LEVEL_RANK[level],
    format,
    suppressJobIdPrefixes: appCfg?.logSuppressJobIdPrefixes ?? [],
  };
  return cached;
}

export function resetBridgeLoggerConfigForTests(): void {
  cached = null;
}

function isSuppressedJobId(jobId: string | undefined, prefixes: readonly string[]): boolean {
  if (!jobId) return false;
  for (const prefix of prefixes) {
    if (jobId.startsWith(prefix)) return true;
  }
  return false;
}

function formatJson(level: LogLevel, message: string, opts?: LogOptions): string {
  const entry: Record<string, string> = {
    app_name: opts?.appName ?? 'bridge-api',
    app_class_name: opts?.appClassName ?? 'unknown',
    job_id: opts?.jobId ?? '',
    log_level: level,
    message,
    timestamp: new Date().toISOString(),
  };
  return JSON.stringify(entry);
}

function formatConsole(level: LogLevel, message: string, opts?: LogOptions): string {
  const parts = [`[${level.toUpperCase()}]`];
  if (opts?.appClassName) parts.push(`[${opts.appClassName}]`);
  parts.push(message);
  if (opts?.jobId) parts.push(`(job=${opts.jobId})`);
  return parts.join(' ');
}

export function forwardToTelemetry(level: LogLevel, message: string, opts?: LogOptions): void {
  emitTelemetryLog('brokkr-bridge', level === 'warning' ? 'warn' : level, message, {
    'brokkr.app_class_name': opts?.appClassName ?? 'unknown',
    'brokkr.job_id': opts?.jobId || undefined,
    'brokkr.app_name': opts?.appName ?? 'bridge-api',
  });
}

function emit(level: LogLevel, message: string, opts?: LogOptions): void {
  // eslint-disable-next-line turbo/no-undeclared-env-vars -- vitest runtime flag, not a build input
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) return;
  const cfg = resolveLoggerConfig();
  if (LEVEL_RANK[level] < cfg.minLevel) return;
  if (isSuppressedJobId(opts?.jobId, cfg.suppressJobIdPrefixes)) return;
  forwardToTelemetry(level, message, opts);
  const line = cfg.format === 'json' ? formatJson(level, message, opts) : formatConsole(level, message, opts);
  /* eslint-disable no-console -- terminal log emitter; nothing lower to call */
  if (level === 'error') console.error(line);
  else if (level === 'warning') console.warn(line);
  else console.log(line);
  /* eslint-enable no-console */
}

export function logDebug(message: string, opts?: LogOptions): void {
  emit('debug', message, opts);
}

export function logInfo(message: string, opts?: LogOptions): void {
  emit('info', message, opts);
}

export function logWarning(message: string, opts?: LogOptions): void {
  emit('warning', message, opts);
}

export function logError(message: string, opts?: LogOptions): void {
  emit('error', message, opts);
}
