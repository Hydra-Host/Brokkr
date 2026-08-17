export type LogLevel = 'debug' | 'info' | 'warning' | 'error';

export interface LogOptions {
  jobId?: string;
  appClassName?: string;
  appName?: string;
}

function emit(level: LogLevel, message: string, opts?: LogOptions): void {
  // eslint-disable-next-line turbo/no-undeclared-env-vars -- vitest runtime flag, not a build input
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) return;
  const parts = [`[${level.toUpperCase()}]`];
  if (opts?.appClassName) parts.push(`[${opts.appClassName}]`);
  parts.push(message);
  if (opts?.jobId) parts.push(`(job=${opts.jobId})`);
  const line = parts.join(' ');
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
