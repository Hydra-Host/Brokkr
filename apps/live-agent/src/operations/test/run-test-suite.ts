import { isRecord } from '@repo/utils';
import { getHandler, registerOperation } from '../../dispatch/registry';
import { runGpuBurn } from '../benchmark/gpu-burn';
import { runNccl } from '../benchmark/nccl';

async function callTestHandler(
  op: string,
  input: unknown,
  ctx: Parameters<Parameters<typeof registerOperation>[1]>[1],
): Promise<Record<string, unknown> | null> {
  const reg = getHandler(op);
  if (!reg) throw new Error(`sub-op not registered: ${op}`);
  try {
    const result = await reg.handler(input, ctx);
    return isRecord(result) ? result : null;
  } catch (error) {
    void error;
    return null;
  }
}

export function registerRunTestSuite(): void {
  registerOperation('test.runTestSuite', async ({ duration, intensity }, ctx) => {
    const [conn, perf, sec] = await Promise.all([
      callTestHandler('test.connectivity', {}, ctx),
      callTestHandler('test.performance', { duration }, ctx),
      callTestHandler('test.security', {}, ctx),
    ]);

    const [gpuBurnRaw, ncclRaw, stress] = await Promise.all([
      runGpuBurn(duration).catch(() => null),
      runNccl().catch(() => null),
      callTestHandler('test.stress', { duration, intensity }, ctx),
    ]);

    const gpuBurn = gpuBurnRaw !== null ? { gpu_burn_in: gpuBurnRaw } : null;
    const nccl = ncclRaw !== null ? { nccl: ncclRaw } : null;

    const results: (Record<string, unknown> | null)[] = [conn, gpuBurn, nccl, perf, sec, stress];

    const merged: Record<string, unknown> = {};
    let successful = 0;
    let failed = 0;
    for (const r of results) {
      if (r === null) {
        failed += 1;
        continue;
      }
      Object.assign(merged, r);
      successful += 1;
    }

    merged['testing_metadata'] = {
      tests_total: results.length,
      tests_successful: successful,
      tests_failed: failed,
      duration,
      intensity,
      job_id: ctx.job_id ?? '',
    };

    return merged;
  });
}
