import type { BrokkrLiveDiagnosticCheck } from '../../brokkr-live/brokkr-live-readiness.service';
import type { BmcCredentials } from '../../common/bmc.types';

export interface PowerManagementServiceLike {
  validateCredentials(creds: BmcCredentials): Promise<Record<string, unknown>>;
  powerOff(creds: BmcCredentials): Promise<Record<string, unknown>>;
  verifyPowerOff(creds: BmcCredentials): Promise<Record<string, unknown>>;
  setBootDevice(
    creds: BmcCredentials,
    bootDevice?: unknown,
    opts?: { persistent?: boolean },
  ): Promise<Record<string, unknown>>;
  verifyBootDevice(creds: BmcCredentials, bootDevice?: unknown): Promise<Record<string, unknown>>;
  powerOn(creds: BmcCredentials): Promise<Record<string, unknown>>;
  verifyPowerOn(
    creds: BmcCredentials,
    opts?: { timeout?: number; pollInterval?: number },
  ): Promise<Record<string, unknown>>;
  verifyBmcRecovery(creds: BmcCredentials): Promise<Record<string, unknown>>;
}

export interface PowerManagementServiceFactoryLike {
  create(jobId: string): Promise<PowerManagementServiceLike>;
}

export interface BrokkrLiveReadinessServiceLike {
  waitForBrokkrLive(
    deviceId: string,
    opts?: {
      initialDelay?: number;
      diagnosticCheck?: BrokkrLiveDiagnosticCheck;
    },
  ): Promise<boolean>;
}

export interface BrokkrLiveReadinessServiceFactoryLike {
  create(jobId: string): Promise<BrokkrLiveReadinessServiceLike>;
}

export interface StepLoggerLike {
  info(message: string, context?: { jobId?: string }): Promise<void>;
  warning(message: string, context?: { jobId?: string }): Promise<void>;
  error(message: string, context?: { jobId?: string }): Promise<void>;
}
