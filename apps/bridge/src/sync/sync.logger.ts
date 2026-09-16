import type { LogLevel } from '../logger/log-levels.js';
import { syncLogDebug, syncLogError, syncLogInfo, syncLogWarning } from '../logger/sync-log.js';

export interface LogContext {
  appClassName?: string;
  jobId?: string;
}

type SyncSink = (message: string, jobId: string, appClassName: string) => void;

const SINKS: Record<LogLevel, SyncSink> = {
  debug: syncLogDebug,
  info: syncLogInfo,
  warning: syncLogWarning,
  error: syncLogError,
};

function emit(level: LogLevel, message: string, context?: LogContext): void {
  SINKS[level](message, context?.jobId ?? '', context?.appClassName ?? 'main');
}

export function logDebug(message: string, context?: LogContext): void {
  emit('debug', message, context);
}

export function logInfo(message: string, context?: LogContext): void {
  emit('info', message, context);
}

export function logWarning(message: string, context?: LogContext): void {
  emit('warning', message, context);
}

export function logError(message: string, context?: LogContext): void {
  emit('error', message, context);
}
