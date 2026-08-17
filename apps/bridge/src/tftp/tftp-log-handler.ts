import { logDebug, logError, logInfo, logWarning, type LogContext } from '../logger/logger.service.js';

export type ServerStatusLevel = 'info' | 'warning' | 'error' | 'debug';

let jobId = '';

export function setTftpJobId(value: string): void {
  jobId = value;
}

export function getTftpJobId(): string {
  return jobId;
}

type LogFn = (message: string, context?: LogContext) => Promise<void>;

const LEVEL_DISPATCH: Record<ServerStatusLevel, LogFn> = {
  info: logInfo,
  warning: logWarning,
  error: logError,
  debug: logDebug,
};

export async function logServerStatus(message: string, level: string = 'info'): Promise<void> {
  const logFn = (LEVEL_DISPATCH as Record<string, LogFn>)[level] ?? logInfo;
  await logFn(`TFTP Server: ${message}`, { jobId, appClassName: 'tftp' });
}
