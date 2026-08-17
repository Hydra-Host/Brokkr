import { Injectable } from '@nestjs/common';

import type { SagaContext } from '../../saga-framework/saga.types';

interface BenchmarkServiceLike {
  reportResults(args: {
    planId: string;
    deviceId: unknown;
    benchmarkResult: Record<string, unknown>;
    ncclJobId: unknown;
    gpuBurnJobId: unknown;
  }): Promise<Record<string, unknown> | null>;
}

interface BenchmarkServiceFactoryLike {
  create(jobId: string): Promise<BenchmarkServiceLike>;
}

@Injectable()
export class ReportResultsStep {
  constructor(private readonly factory: BenchmarkServiceFactoryLike) {}

  async execute(ctx: SagaContext): Promise<Record<string, unknown> | null> {
    const benchmarkResult = (ctx.stepResults.run_benchmarks as Record<string, unknown> | undefined) ?? {};
    if (benchmarkResult.skipped) {
      return { reported: true, skipped: true };
    }

    const payload = ctx.payload;
    const service = await this.factory.create(ctx.jobId);
    return service.reportResults({
      planId: ctx.planId,
      deviceId: ctx.deviceId,
      benchmarkResult,
      ncclJobId: 'nccl_job_id' in payload ? payload.nccl_job_id : null,
      gpuBurnJobId: 'gpu_burn_job_id' in payload ? payload.gpu_burn_job_id : null,
    });
  }
}
