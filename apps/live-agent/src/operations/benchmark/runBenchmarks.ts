import { registerOperation } from '../../dispatch/registry';
import { getErrorMessage } from '../../errors';
import { runGpuBurn, type GpuBurnResult } from './gpuBurn';
import { runNccl, type NcclResult } from './nccl';

export function registerRunBenchmarks(): void {
  registerOperation('benchmark.runBenchmarks', async ({ benchmark_type, duration }, ctx) => {
    const skipGpuBurn = benchmark_type === 'nccl';
    const skipNccl = benchmark_type === 'gpu_burn';

    ctx.reportProgress(0, `benchmark.run starting (type=${benchmark_type})`);

    let gpuBurn: GpuBurnResult | { status: 'skipped'; reason: string } = {
      status: 'skipped',
      reason: 'skip_gpu_burn flag',
    };
    if (!skipGpuBurn) {
      ctx.reportProgress(1 / 4, `gpu_burn_start (duration=${duration})`);
      try {
        gpuBurn = await runGpuBurn(duration);
      } catch (error) {
        gpuBurn = { test_passed: false, error: getErrorMessage(error) };
      }
      ctx.reportProgress(2 / 4, 'gpu_burn_done');
    }

    let nccl: NcclResult | { status: 'skipped'; reason: string } = {
      status: 'skipped',
      reason: 'skip_nccl flag',
    };
    if (!skipNccl) {
      ctx.reportProgress(3 / 4, 'nccl_start');
      try {
        nccl = await runNccl();
      } catch (error) {
        nccl = { test_passed: false, error: getErrorMessage(error) };
      }
      ctx.reportProgress(4 / 4, 'nccl_done');
    }

    const gpu_benchmarks: Record<string, unknown> = {
      gpu_burn: gpuBurn,
      nccl,
    };

    const gpuBurnPassed = 'test_passed' in gpuBurn ? gpuBurn.test_passed : false;
    const ncclPassed = 'test_passed' in nccl ? nccl.test_passed : false;

    return {
      benchmark_type,
      gpu_benchmarks,
      gpu_burn_passed: gpuBurnPassed,
      nccl_passed: ncclPassed,
    };
  });
}
