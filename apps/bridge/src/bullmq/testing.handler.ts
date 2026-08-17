import { Injectable } from '@nestjs/common';
import { isRecord } from '@repo/utils';
import { getErrorMessage } from '../common/error-utils';

import type { OperationName, OperationOutput } from '@repo/bridge-agent-protocol';

import { AgentNotConnected, DispatchFailed, DispatchTimeout } from '../agent/dispatch/grpc.exceptions';

import type { JobHandler, ProcessableJob } from './handlers.service';

export interface TestingDispatcherLike {
  dispatchTyped<N extends OperationName>(
    deviceId: string,
    operation: N,
    input: unknown,
    options: { jobId?: string | null; timeoutS?: number | null },
  ): Promise<OperationOutput<N>>;
}

export interface TestingRegistryLike {
  isConnected(deviceId: string): boolean;
}

export interface TestingLogger {
  info(message: string, context?: { jobId?: string }): Promise<void>;
  error(message: string, context?: { jobId?: string }): Promise<void>;
}

const DEFAULT_DURATION = '30m';
const DEFAULT_INTENSITY = 'normal';
const PHASE_DURATION_MULTIPLE = 8;
const TESTING_TIMEOUT_BUFFER_S = 600;
const FALLBACK_DURATION_MINUTES = 30;
const NCCL_WORST_CASE_RUNTIME_S = 3600;

function parseDurationMinutes(durationStr: string): number {
  const s = durationStr.trim();
  const num = Number.parseInt(s, 10);
  if (!Number.isFinite(num) || num <= 0) return FALLBACK_DURATION_MINUTES;
  const unit = s.slice(-1);
  if (unit === 'h') return num * 60;
  if (unit === 'd') return num * 60 * 24;
  return num;
}

export function testingTimeoutS(duration: unknown): number {
  const durationStr = typeof duration === 'string' ? duration : DEFAULT_DURATION;
  const scaled = parseDurationMinutes(durationStr) * 60 * PHASE_DURATION_MULTIPLE + TESTING_TIMEOUT_BUFFER_S;
  return Math.max(scaled, NCCL_WORST_CASE_RUNTIME_S + TESTING_TIMEOUT_BUFFER_S);
}

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
export class TestingJobHandler {
  constructor(
    private readonly dispatcher: TestingDispatcherLike,
    private readonly registry: TestingRegistryLike,
    private readonly logger: TestingLogger,
  ) {}

  readonly handle: JobHandler = async (job) => this.run(job);

  private async run(job: ProcessableJob<Record<string, unknown>>): Promise<Record<string, unknown>> {
    const deviceIdRaw = requireKey(job.data, 'device_id');
    const deviceIdStr = String(deviceIdRaw);
    const planIdRaw = job.data['plan_id'] ?? '';
    const jobIdRaw = job.data['job_id'] ?? '';
    const effectiveJobIdRaw = jobIdRaw !== '' && jobIdRaw != null ? jobIdRaw : planIdRaw;
    const effectiveJobId = jobIdBoundary(effectiveJobIdRaw);
    const duration = job.data['duration'] ?? DEFAULT_DURATION;
    const intensity = job.data['intensity'] ?? DEFAULT_INTENSITY;

    await this.logger.info(`Starting testing for device ${deviceIdStr} (duration=${String(duration)})`, {
      jobId: effectiveJobId ?? undefined,
    });

    try {
      if (!this.registry.isConnected(deviceIdStr)) {
        throw new AgentNotConnected(deviceIdStr);
      }

      let results: OperationOutput<'test.runTestSuite'>;
      try {
        results = await this.dispatcher.dispatchTyped(
          deviceIdStr,
          'test.runTestSuite',
          { duration, intensity },
          { jobId: effectiveJobId, timeoutS: testingTimeoutS(duration) },
        );
      } catch (exc) {
        if (exc instanceof DispatchTimeout) {
          throw new Error(`Testing timed out for device ${deviceIdStr}: ${exc.message}`);
        }
        if (exc instanceof DispatchFailed) {
          throw new Error(`Testing dispatch failed for device ${deviceIdStr}: ${exc.message}`);
        }
        throw exc;
      }

      const metadataRaw = results['testing_metadata'];
      const metadataMap = isRecord(metadataRaw) ? metadataRaw : {};
      const successful = metadataMap['tests_successful'] ?? 0;
      const total = metadataMap['tests_total'] ?? 0;
      await this.logger.info(`Testing complete for device ${deviceIdStr}: ${String(successful)}/${String(total)}`, {
        jobId: effectiveJobId ?? undefined,
      });
      return { device_id: deviceIdRaw, status: 'complete', metadata: metadataMap };
    } catch (exc) {
      await this.logger.error(`Testing failed for device ${deviceIdStr}: ${getErrorMessage(exc)}`, {
        jobId: effectiveJobId ?? undefined,
      });
      throw exc;
    }
  }
}
