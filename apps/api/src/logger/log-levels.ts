import { LogLevel } from '@nestjs/common';

const LOG_LEVEL_ALIASES: Record<string, LogLevel> = {
  info: 'log',
  warning: 'warn',
};

const ORDERED_LEVELS: LogLevel[] = ['verbose', 'debug', 'log', 'warn', 'error', 'fatal'];

function resolveLogLevel(raw: string): LogLevel {
  const normalized = raw.toLowerCase().trim();
  return LOG_LEVEL_ALIASES[normalized] ?? (normalized as LogLevel);
}

export function getLogLevels(): LogLevel[] {
  const level = resolveLogLevel(process.env.LOG_LEVEL || 'log');
  const index = ORDERED_LEVELS.indexOf(level);

  if (index === -1) {
    console.warn(`[LogLevels] Unknown LOG_LEVEL "${process.env.LOG_LEVEL}", defaulting to "log"`);
    return ORDERED_LEVELS.slice(ORDERED_LEVELS.indexOf('log'));
  }

  return ORDERED_LEVELS.slice(index);
}
