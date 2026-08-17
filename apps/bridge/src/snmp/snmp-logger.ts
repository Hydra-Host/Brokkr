import { getLogger } from '../logger/logger.service';

export interface SnmpLogger {
  info(message: string, ctx?: { jobId?: string }): Promise<void>;
  warn(message: string, ctx?: { jobId?: string }): Promise<void>;
}

export function defaultSnmpLogger(): SnmpLogger {
  return {
    info: (message, ctx) => getLogger().info(message, ctx),
    warn: (message, ctx) => getLogger().warning(message, ctx),
  };
}
