import { Injectable } from '@nestjs/common';
import { getErrorMessage } from '../common/error-utils';

import type { OperationName, OperationOutput } from '@repo/bridge-agent-protocol';
import { isRecord } from '@repo/utils';

import { ContextLogger } from '../logger/logger.service';

export interface BenchmarkServiceLogger {
  info(message: string, context?: { jobId?: string }): Promise<void>;
  warning(message: string, context?: { jobId?: string }): Promise<void>;
}

export type BenchmarkDispatchFn = <N extends OperationName>(
  deviceId: string,
  operation: N,
  input: unknown,
  options?: { jobId?: string; timeoutS?: number },
) => Promise<OperationOutput<N>>;

export interface BenchmarkResultProducer {
  enqueueResult(args: {
    planId: string;
    stepName: string;
    status: string;
    deviceId: unknown;
    eventType: string;
    actionType: string;
    result: Record<string, unknown>;
  }): Promise<boolean>;
}

export interface RunBenchmarksArgs {
  deviceId: string;
  benchmarkType: unknown;
  duration: unknown;
}

export interface ReportResultsArgs {
  planId: string;
  deviceId: unknown;
  benchmarkResult: Record<string, unknown>;
  ncclJobId: unknown;
  gpuBurnJobId: unknown;
}

export class BenchmarkService {
  constructor(
    public readonly jobId: string,
    private readonly dispatch: BenchmarkDispatchFn,
    private readonly results: BenchmarkResultProducer,
    private readonly logger: BenchmarkServiceLogger,
  ) {}

  async checkCcMode(deviceId: string): Promise<Record<string, unknown>> {
    await this.logger.info(`Checking CC mode on device ${deviceId}`, { jobId: this.jobId });

    try {
      const result = await this.dispatch(
        String(deviceId),
        'benchmark.checkCcMode',
        {},
        { jobId: this.jobId, timeoutS: 180 },
      );
      if (result.cc_enabled) {
        await this.logger.warning('Confidential Compute is enabled, benchmarks will be skipped', { jobId: this.jobId });
        return { cc_enabled: true, skip_benchmarks: true };
      }
      if (result.cc_check_error) {
        await this.logger.warning(`CC check failed (proceeding anyway): ${result.cc_check_error}`, {
          jobId: this.jobId,
        });
        return { cc_enabled: false, cc_check_error: result.cc_check_error };
      }
      await this.logger.info('Confidential Compute is not enabled', { jobId: this.jobId });
      return { cc_enabled: false };
    } catch (error) {
      await this.logger.warning(`CC check dispatch failed (proceeding anyway): ${getErrorMessage(error)}`, {
        jobId: this.jobId,
      });
      return { cc_enabled: false, cc_check_error: getErrorMessage(error) };
    }
  }

  async runBenchmarks(args: RunBenchmarksArgs): Promise<Record<string, unknown>> {
    const { deviceId, benchmarkType, duration } = args;
    await this.logger.info(
      `Running benchmarks on device ${deviceId} (type=${String(benchmarkType)}, duration=${String(duration)})`,
      { jobId: this.jobId },
    );

    const result = await this.dispatch(
      String(deviceId),
      'benchmark.runBenchmarks',
      { benchmark_type: benchmarkType, duration },
      { jobId: this.jobId, timeoutS: 3.5 * 3600 },
    );

    const gpuBenchmarks = result.gpu_benchmarks;
    const gpuBurnPassed = result.gpu_burn_passed;
    const ncclPassed = result.nccl_passed;

    await this.logger.info(
      `Benchmarks complete: gpu_burn=${gpuBurnPassed ? 'PASS' : 'FAIL'}, nccl=${ncclPassed ? 'PASS' : 'FAIL'}`,
      { jobId: this.jobId },
    );

    return {
      benchmark_type: benchmarkType,
      gpu_benchmarks: gpuBenchmarks,
      gpu_burn_passed: gpuBurnPassed,
      nccl_passed: ncclPassed,
    };
  }

  async reportResults(args: ReportResultsArgs): Promise<Record<string, unknown>> {
    const { planId, deviceId, benchmarkResult, ncclJobId, gpuBurnJobId } = args;
    const gpuBenchmarksRaw = isRecord(benchmarkResult.gpu_benchmarks) ? benchmarkResult.gpu_benchmarks : {};

    let gpuBurnEntry: unknown = undefined;
    let gpuBurnReported = false;
    if (gpuBurnJobId) {
      gpuBurnEntry = gpuBenchmarksRaw.gpu_burn;
      gpuBurnReported = !!gpuBurnEntry;
    }
    if (gpuBurnReported) {
      if (!isRecord(gpuBurnEntry)) {
        throw new TypeError('Expected benchmark entry to be an object');
      }
      const gpuBurnData = { ...gpuBurnEntry, deviceId: String(deviceId), jobId: gpuBurnJobId };

      await this.results.enqueueResult({
        planId,
        stepName: 'gpu_burn_result',
        status: 'completed',
        deviceId,
        eventType: 'stage_changed',
        actionType: 'benchmarks',
        result: {
          test_type: 'GpuBurnIn',
          test_run_id: gpuBurnJobId,
          test_passed: benchmarkResult.gpu_burn_passed ?? false,
          data: gpuBurnData,
        },
      });
    }

    let ncclEntry: unknown = undefined;
    let ncclReported = false;
    if (ncclJobId) {
      ncclEntry = gpuBenchmarksRaw.nccl;
      ncclReported = !!ncclEntry;
    }
    if (ncclReported) {
      if (!isRecord(ncclEntry)) {
        throw new TypeError('Expected benchmark entry to be an object');
      }
      const ncclData = { ...ncclEntry, deviceId: String(deviceId), jobId: ncclJobId };

      await this.results.enqueueResult({
        planId,
        stepName: 'nccl_result',
        status: 'completed',
        deviceId,
        eventType: 'stage_changed',
        actionType: 'benchmarks',
        result: {
          test_type: 'NcclPerformance',
          test_run_id: ncclJobId,
          test_passed: benchmarkResult.nccl_passed ?? false,
          data: ncclData,
        },
      });
    }

    await this.logger.info('Benchmark results reported to hub', { jobId: this.jobId });
    return {
      reported: true,
      gpu_burn_reported: gpuBurnReported,
      nccl_reported: ncclReported,
    };
  }
}

@Injectable()
export class BenchmarkServiceFactory {
  constructor(
    private readonly dispatch: BenchmarkDispatchFn,
    private readonly results: BenchmarkResultProducer,
    private readonly logger: ContextLogger,
  ) {}

  async create(jobId: string): Promise<BenchmarkService> {
    return new BenchmarkService(jobId, this.dispatch, this.results, this.logger);
  }
}
