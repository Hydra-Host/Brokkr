export interface LogContext {
  appClassName?: string;
  jobId?: string;
}

function emit(_level: 'debug' | 'info' | 'warning' | 'error', _message: string, _context?: LogContext): void {}

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
