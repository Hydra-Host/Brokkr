import { getLogger } from '../logger/logger.service.js';

export type { TftpConfig } from '../tftp/tftp.config.js';

export interface AppConfig {
  analyticsEnabled: boolean;
  bridgeSyncEnabled: boolean;
  environment: string;
  host: string;
  port: number;
  version: string;
  zoneId: string;
}

export interface SyncConfig {
  osLayerUrl: string;
}

export interface GrpcConfig {
  enabled: boolean;
  internalHost: string;
  internalPort: number;
}

export interface MonitoringConfig {
  telegrafEnabled: boolean;
}

export interface LoggerContext {
  jobId?: string;
  appClassName?: string;
}

export type LogFn = (message: string, context?: LoggerContext) => void;

export interface StartupLogger {
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  debug: LogFn;
}

export const STARTUP_LOGGER: StartupLogger = {
  info: (msg, ctx) => void getLogger().info(msg, ctx),
  warn: (msg, ctx) => void getLogger().warning(msg, ctx),
  error: (msg, ctx) => void getLogger().error(msg, ctx),
  debug: (msg, ctx) => void getLogger().debug(msg, ctx),
};
