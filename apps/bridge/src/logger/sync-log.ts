import { JobIdPrefixFilter } from './context/job-id-prefix-filter';
import { NUMERIC_LEVELS } from './log-levels';
import {
  BridgeSyncHandler,
  getSuppressedJobIdPrefixes,
  resolveFormatter,
  resolveLogLevel,
  type LogLevel,
} from './logger.service';

function emitSync(level: LogLevel, message: string, jobId: string, appClassName: string): void {
  const env = process.env;
  const configured = resolveLogLevel(env);
  if (NUMERIC_LEVELS[level] < NUMERIC_LEVELS[configured]) return;

  const handler = new BridgeSyncHandler(process.stdout, resolveFormatter(env));
  handler.setLevel(configured);
  handler.setFilter(new JobIdPrefixFilter(getSuppressedJobIdPrefixes(env)));
  handler.emit({
    level,
    message,
    jobId,
    appClassName,
    appName: 'bridge-api',
  });
}

export function syncLogInfo(message: string, jobId: string = '', appClassName: string = 'main'): void {
  emitSync('info', message, jobId, appClassName);
}

export function syncLogWarning(message: string, jobId: string = '', appClassName: string = 'main'): void {
  emitSync('warning', message, jobId, appClassName);
}

export function syncLogError(message: string, jobId: string = '', appClassName: string = 'main'): void {
  emitSync('error', message, jobId, appClassName);
}
