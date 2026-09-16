export type LogLevel = 'debug' | 'info' | 'warning' | 'error';

export const LOG_LEVELS: Record<'DEBUG' | 'INFO' | 'WARNING' | 'ERROR', number> = {
  DEBUG: 10,
  INFO: 20,
  WARNING: 30,
  ERROR: 40,
};

export const NUMERIC_LEVELS: Record<LogLevel, number> = {
  debug: LOG_LEVELS.DEBUG,
  info: LOG_LEVELS.INFO,
  warning: LOG_LEVELS.WARNING,
  error: LOG_LEVELS.ERROR,
};

const LOG_LEVEL_ALIAS_MAP: Record<string, LogLevel> = {
  debug: 'debug',
  info: 'info',
  warning: 'warning',
  warn: 'warning',
  error: 'error',
};

export function resolveLogLevel(env: NodeJS.ProcessEnv = process.env): LogLevel {
  const raw = env.LOG_LEVEL?.trim().toLowerCase();
  if (!raw) return 'info';
  return LOG_LEVEL_ALIAS_MAP[raw] ?? 'info';
}
