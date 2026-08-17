import { describe, expect, it, vi } from 'vitest';

import {
  BenchmarkService,
  type BenchmarkDispatchFn,
  type BenchmarkResultProducer,
  type BenchmarkServiceLogger,
} from '../benchmark.service';

function makeService() {
  const enqueueResult = vi.fn<BenchmarkResultProducer['enqueueResult']>().mockResolvedValue(true);
  const results: BenchmarkResultProducer = { enqueueResult };
  const dispatch = vi.fn<BenchmarkDispatchFn>().mockResolvedValue({});
  const logger: BenchmarkServiceLogger = {
    info: vi.fn().mockResolvedValue(undefined),
    warning: vi.fn().mockResolvedValue(undefined),
  };
  const service = new BenchmarkService('job-1', dispatch, results, logger);
  return { service, enqueueResult, dispatch, logger };
}

describe('BenchmarkService.reportResults', () => {
  it('does not mutate the dispatch-response benchmark entries', async () => {
    const gpuBurnEntry = { score: 100 };
    const ncclEntry = { bandwidth: 42 };
    const benchmarkResult = {
      gpu_burn_passed: true,
      nccl_passed: true,
      gpu_benchmarks: { gpu_burn: gpuBurnEntry, nccl: ncclEntry },
    };

    const { service } = makeService();
    await service.reportResults({
      planId: 'plan-1',
      deviceId: 7,
      benchmarkResult,
      ncclJobId: 'nccl-job',
      gpuBurnJobId: 'burn-job',
    });

    expect(gpuBurnEntry).toEqual({ score: 100 });
    expect(ncclEntry).toEqual({ bandwidth: 42 });
    expect(gpuBurnEntry).not.toHaveProperty('deviceId');
    expect(gpuBurnEntry).not.toHaveProperty('jobId');
    expect(ncclEntry).not.toHaveProperty('deviceId');
    expect(ncclEntry).not.toHaveProperty('jobId');
  });

  it('enqueues freshly constructed data containing the original fields plus deviceId/jobId', async () => {
    const benchmarkResult = {
      gpu_burn_passed: true,
      nccl_passed: false,
      gpu_benchmarks: { gpu_burn: { score: 100 }, nccl: { bandwidth: 42 } },
    };

    const { service, enqueueResult } = makeService();
    await service.reportResults({
      planId: 'plan-1',
      deviceId: 7,
      benchmarkResult,
      ncclJobId: 'nccl-job',
      gpuBurnJobId: 'burn-job',
    });

    expect(enqueueResult).toHaveBeenCalledTimes(2);

    const gpuBurnCall = enqueueResult.mock.calls.find((c) => c[0].stepName === 'gpu_burn_result')?.[0];
    expect(gpuBurnCall?.result.data).toEqual({ score: 100, deviceId: '7', jobId: 'burn-job' });
    expect(gpuBurnCall?.result.data).not.toBe(benchmarkResult.gpu_benchmarks.gpu_burn);

    const ncclCall = enqueueResult.mock.calls.find((c) => c[0].stepName === 'nccl_result')?.[0];
    expect(ncclCall?.result.data).toEqual({ bandwidth: 42, deviceId: '7', jobId: 'nccl-job' });
    expect(ncclCall?.result.data).not.toBe(benchmarkResult.gpu_benchmarks.nccl);
  });

  it('throws an idiomatic TS error (no Python idiom) when an entry is not an object', async () => {
    const benchmarkResult = {
      gpu_burn_passed: true,
      gpu_benchmarks: { gpu_burn: 'not-an-object' },
    };

    const { service } = makeService();
    await expect(
      service.reportResults({
        planId: 'plan-1',
        deviceId: 7,
        benchmarkResult,
        ncclJobId: undefined,
        gpuBurnJobId: 'burn-job',
      }),
    ).rejects.toThrow(/Expected benchmark entry to be an object/);

    await expect(
      service.reportResults({
        planId: 'plan-1',
        deviceId: 7,
        benchmarkResult,
        ncclJobId: undefined,
        gpuBurnJobId: 'burn-job',
      }),
    ).rejects.not.toThrow(/does not support item assignment/);
  });

  it('reports the expected reported flags for the immediate consumer', async () => {
    const benchmarkResult = {
      gpu_burn_passed: true,
      nccl_passed: true,
      gpu_benchmarks: { gpu_burn: { score: 100 }, nccl: { bandwidth: 42 } },
    };

    const { service } = makeService();
    const out = await service.reportResults({
      planId: 'plan-1',
      deviceId: 7,
      benchmarkResult,
      ncclJobId: 'nccl-job',
      gpuBurnJobId: 'burn-job',
    });

    expect(out).toEqual({ reported: true, gpu_burn_reported: true, nccl_reported: true });
  });
});
