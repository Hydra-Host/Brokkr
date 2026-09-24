import type { LogContext } from '../../logger/logger.service.js';
import type { IPMIDevice } from '../ipmi/device.js';
import type { IPMIResult } from '../ipmi/result.js';

export type { IPMIDevice, IPMIResult };

export interface SolCache {
  rpush(key: string, values: readonly string[], jobId?: string): Promise<number>;
  expire(key: string, seconds: number, jobId?: string): Promise<boolean>;
}

export type SolStream = AsyncGenerator<Buffer, void, unknown>;

export type SolStreamFactory = (device: IPMIDevice) => SolStream;

export type SolCipherFn = (device: IPMIDevice, deviceId?: string | null) => Promise<string | null>;

export type SolDeactivateFn = (device: IPMIDevice) => Promise<IPMIResult>;

export type SolPingFn = (ipAddress: string, port: number, jobId: string) => Promise<Record<string, unknown>>;

export interface SolLogger {
  info(message: string, context?: LogContext): void | Promise<void>;
  warning(message: string, context?: LogContext): void | Promise<void>;
  error(message: string, context?: LogContext): void | Promise<void>;
  debug(message: string, context?: LogContext): void | Promise<void>;
}
