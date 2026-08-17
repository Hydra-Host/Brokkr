import { Injectable } from '@nestjs/common';
import { isRecord } from '@repo/utils';
import { getErrorMessage } from '../common/error-utils';

import type { OperationName, OperationOutput } from '@repo/bridge-agent-protocol';

import { AgentNotConnected, DispatchFailed, DispatchTimeout } from '../agent/dispatch/grpc.exceptions';

import type { JobHandler, ProcessableJob } from './handlers.service';

export interface DiagnosticsDispatcherLike {
  dispatchTyped<N extends OperationName>(
    deviceId: string,
    operation: N,
    input: unknown,
    options: { jobId?: string | null; timeoutS?: number | null },
  ): Promise<OperationOutput<N>>;
}

export interface DiagnosticsRegistryLike {
  isConnected(deviceId: string): boolean;
}

export interface DiagnosticsLogger {
  info(message: string, context?: { jobId?: string }): Promise<void>;
  error(message: string, context?: { jobId?: string }): Promise<void>;
}

const DIAGNOSTICS_TIMEOUT_S = 10 * 60;

function requireKey(obj: Record<string, unknown>, key: string): unknown {
  if (!(key in obj)) {
    throw new Error(`Missing required property '${key}'`);
  }
  return obj[key];
}

function jobIdBoundary(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

@Injectable()
export class DiagnosticsJobHandler {
  constructor(
    private readonly dispatcher: DiagnosticsDispatcherLike,
    private readonly registry: DiagnosticsRegistryLike,
    private readonly logger: DiagnosticsLogger,
  ) {}

  readonly handle: JobHandler = async (job) => this.run(job);

  private async run(job: ProcessableJob<Record<string, unknown>>): Promise<Record<string, unknown>> {
    const deviceIdRaw = requireKey(job.data, 'device_id');
    const deviceIdStr = String(deviceIdRaw);
    const planIdRaw = job.data['plan_id'] ?? '';
    const jobIdRaw = job.data['job_id'] ?? '';
    const effectiveJobIdRaw = jobIdRaw !== '' && jobIdRaw != null ? jobIdRaw : planIdRaw;
    const effectiveJobId = jobIdBoundary(effectiveJobIdRaw);

    await this.logger.info(`Starting diagnostics for device ${deviceIdStr}`, {
      jobId: effectiveJobId ?? undefined,
    });

    try {
      if (!this.registry.isConnected(deviceIdStr)) {
        throw new AgentNotConnected(deviceIdStr);
      }

      let results: OperationOutput<'diagnostic.runAll'>;
      try {
        results = await this.dispatcher.dispatchTyped(
          deviceIdStr,
          'diagnostic.runAll',
          {},
          { jobId: effectiveJobId, timeoutS: DIAGNOSTICS_TIMEOUT_S },
        );
      } catch (exc) {
        if (exc instanceof DispatchTimeout) {
          throw new Error(`Diagnostics timed out for device ${deviceIdStr}: ${exc.message}`);
        }
        if (exc instanceof DispatchFailed) {
          throw new Error(`Diagnostics dispatch failed for device ${deviceIdStr}: ${exc.message}`);
        }
        throw exc;
      }

      const metadataRaw = results['diagnostics_metadata'];
      const metadataMap = isRecord(metadataRaw) ? metadataRaw : {};
      const successful = metadataMap['diagnostics_successful'] ?? 0;
      const total = metadataMap['diagnostics_total'] ?? 0;
      await this.logger.info(`Diagnostics complete for device ${deviceIdStr}: ${String(successful)}/${String(total)}`, {
        jobId: effectiveJobId ?? undefined,
      });
      return { device_id: deviceIdRaw, status: 'complete', metadata: metadataMap };
    } catch (exc) {
      await this.logger.error(`Diagnostics failed for device ${deviceIdStr}: ${getErrorMessage(exc)}`, {
        jobId: effectiveJobId ?? undefined,
      });
      throw exc;
    }
  }
}
