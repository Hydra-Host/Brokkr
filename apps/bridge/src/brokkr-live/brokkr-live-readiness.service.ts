import { Inject, Injectable, Optional } from '@nestjs/common';

import { ConnectionRegistry } from '../agent/connection-registry/connection-registry.service';
import { getBullmqConfig } from '../bullmq/bullmq.config';
import { sleep } from '../common/async/abortable';
import { getShutdownSignal, ShutdownRequested } from '../common/async/shutdown-signal';
import { getLogger } from '../logger/logger.service';

export interface BrokkrLiveReadinessLogger {
  info(message: string, context?: { jobId?: string }): Promise<void>;
  error(message: string, context?: { jobId?: string }): Promise<void>;
}

const FORWARDING_LOGGER: BrokkrLiveReadinessLogger = {
  info: (msg, ctx) => getLogger().info(msg, ctx),
  error: (msg, ctx) => getLogger().error(msg, ctx),
};

export const BROKKR_LIVE_READINESS_LOGGER = Symbol('BrokkrLiveReadinessLogger');

export interface WaitForBrokkrLiveOptions {
  initialDelay?: number;
  diagnosticCheck?: BrokkrLiveDiagnosticCheck;
}

export type BrokkrLiveDiagnosticCheck = () => Promise<BrokkrLiveReadinessDiagnostic | null | undefined>;

const POLL_INTERVAL_S = 5;
const LOG_INTERVAL_S = 30;
// Above measured slow-normal GPU boots (~400s) so the early warning only fires on genuinely abnormal waits.
const LONGER_THAN_EXPECTED_SECONDS = 600;
const DIAGNOSTIC_INTERVAL_S = 30;
const DIAGNOSTIC_FAILURES_TO_FAIL = 2;

function monotonicSec(): number {
  return performance.now() / 1000;
}

function sleepSec(seconds: number, signal?: AbortSignal): Promise<void> {
  return sleep(seconds * 1000, signal);
}

export interface BrokkrLiveReadinessTiming {
  initialDelaySeconds: number;
  maxWaitSeconds: number;
  now?: () => number;
  sleep?: (seconds: number, signal?: AbortSignal) => Promise<void>;
  pollIntervalSeconds?: number;
  logIntervalSeconds?: number;
  longerThanExpectedSeconds?: number;
  diagnosticIntervalSeconds?: number;
  diagnosticFailuresToFail?: number;
}

export interface BrokkrLiveReadinessDiagnostic {
  ok: boolean;
  reason?: string;
  inconclusive?: boolean;
}

export class BrokkrLiveReadinessService {
  private readonly now: () => number;
  private readonly sleep: (seconds: number, signal?: AbortSignal) => Promise<void>;
  private readonly initialDelaySeconds: number;
  private readonly maxWaitSeconds: number;
  private readonly pollIntervalSeconds: number;
  private readonly logIntervalSeconds: number;
  private readonly longerThanExpectedSeconds: number;
  private readonly diagnosticIntervalSeconds: number;
  private readonly diagnosticFailuresToFail: number;

  constructor(
    private readonly jobId: string,
    private readonly registry: ConnectionRegistry,
    private readonly logger: BrokkrLiveReadinessLogger,
    timing: BrokkrLiveReadinessTiming,
    private readonly shutdownSignal: () => AbortSignal | undefined = getShutdownSignal,
  ) {
    this.now = timing.now ?? monotonicSec;
    this.sleep = timing.sleep ?? sleepSec;
    this.initialDelaySeconds = timing.initialDelaySeconds;
    this.maxWaitSeconds = timing.maxWaitSeconds;
    this.pollIntervalSeconds = timing.pollIntervalSeconds ?? POLL_INTERVAL_S;
    this.logIntervalSeconds = timing.logIntervalSeconds ?? LOG_INTERVAL_S;
    this.longerThanExpectedSeconds = timing.longerThanExpectedSeconds ?? LONGER_THAN_EXPECTED_SECONDS;
    this.diagnosticIntervalSeconds = timing.diagnosticIntervalSeconds ?? DIAGNOSTIC_INTERVAL_S;
    this.diagnosticFailuresToFail = timing.diagnosticFailuresToFail ?? DIAGNOSTIC_FAILURES_TO_FAIL;
  }

  async waitForBrokkrLive(deviceId: string, opts: WaitForBrokkrLiveOptions = {}): Promise<boolean> {
    const initialDelay = opts.initialDelay ?? this.initialDelaySeconds;
    const signal = this.shutdownSignal();
    this.throwIfShuttingDown(deviceId, signal);

    await this.logger.info(`Waiting for Brokkr Live OS on device ${deviceId}`, {
      jobId: this.jobId,
    });

    if (initialDelay > 0) {
      await this.logger.info(`Waiting ${initialDelay}s for machine to boot before first check`, { jobId: this.jobId });
      await this.waitOrAbort(initialDelay, deviceId, signal);
    }

    const start = this.now();
    let lastLog = start;
    let lastDiagnostic = start - this.diagnosticIntervalSeconds;
    let consecutiveDiagnosticFailures = 0;
    let loggedLongerThanExpected = false;

    while (this.now() - start < this.maxWaitSeconds) {
      if (this.registry.isConnected(String(deviceId))) {
        const elapsed = Math.trunc(this.now() - start);
        await this.logger.info(`Brokkr Live agent connected for device ${deviceId} (${elapsed}s elapsed)`, {
          jobId: this.jobId,
        });
        return true;
      }

      const now = this.now();
      const elapsed = now - start;
      if (!loggedLongerThanExpected && elapsed >= this.longerThanExpectedSeconds) {
        loggedLongerThanExpected = true;
        await this.logger.info(
          `Brokkr Live readiness longer than expected for device ${deviceId}: waiting_for=agent_registration elapsed=${Math.trunc(
            elapsed,
          )}s expected=${this.longerThanExpectedSeconds}s cap=${this.maxWaitSeconds}s`,
          { jobId: this.jobId },
        );
      }

      if (now - lastLog >= this.logIntervalSeconds) {
        await this.logger.info(
          `Still waiting for agent connection for device ${deviceId} (${Math.trunc(elapsed)}s elapsed)`,
          {
            jobId: this.jobId,
          },
        );
        lastLog = now;
      }

      if (opts.diagnosticCheck !== undefined && now - lastDiagnostic >= this.diagnosticIntervalSeconds) {
        lastDiagnostic = now;
        const diagnostic = await opts.diagnosticCheck();
        if (diagnostic?.ok === true) {
          consecutiveDiagnosticFailures = 0;
        } else if (diagnostic?.ok === false && !diagnostic.inconclusive) {
          consecutiveDiagnosticFailures += 1;
          const reason = diagnostic.reason ?? 'diagnostic check failed';
          await this.logger.info(
            `Brokkr Live readiness diagnostic failed for device ${deviceId} (${consecutiveDiagnosticFailures}/${this.diagnosticFailuresToFail}): ${reason}`,
            { jobId: this.jobId },
          );
          if (consecutiveDiagnosticFailures >= this.diagnosticFailuresToFail) {
            throw new Error(`Brokkr Live readiness failed early for device ${deviceId}: ${reason}`);
          }
        } else {
          const reason = diagnostic?.reason ?? 'no result';
          await this.logger.info(`Brokkr Live readiness diagnostic inconclusive for device ${deviceId}: ${reason}`, {
            jobId: this.jobId,
          });
        }
      }

      await this.waitOrAbort(this.pollIntervalSeconds, deviceId, signal);
    }

    const elapsed = Math.trunc(this.now() - start);
    await this.logger.error(`Brokkr Live agent did not connect for device ${deviceId} after ${elapsed}s`, {
      jobId: this.jobId,
    });
    return false;
  }

  private async waitOrAbort(seconds: number, deviceId: string, signal: AbortSignal | undefined): Promise<void> {
    await this.sleep(seconds, signal);
    this.throwIfShuttingDown(deviceId, signal);
  }

  private throwIfShuttingDown(deviceId: string, signal: AbortSignal | undefined): void {
    if (signal?.aborted !== true) return;
    throw new ShutdownRequested(`Brokkr Live readiness wait for device ${deviceId} aborted: bridge shutting down`);
  }
}

@Injectable()
export class BrokkrLiveReadinessServiceFactory {
  private readonly logger: BrokkrLiveReadinessLogger;

  constructor(
    private readonly registry: ConnectionRegistry,
    @Optional() @Inject(BROKKR_LIVE_READINESS_LOGGER) logger?: BrokkrLiveReadinessLogger,
  ) {
    this.logger = logger ?? FORWARDING_LOGGER;
  }

  async create(jobId: string, timing: Partial<BrokkrLiveReadinessTiming> = {}): Promise<BrokkrLiveReadinessService> {
    const config = getBullmqConfig();
    return new BrokkrLiveReadinessService(jobId, this.registry, this.logger, {
      ...timing,
      initialDelaySeconds: timing.initialDelaySeconds ?? config.brokkrLiveInitialDelaySeconds,
      maxWaitSeconds: timing.maxWaitSeconds ?? config.brokkrLiveWaitSeconds,
    });
  }
}
