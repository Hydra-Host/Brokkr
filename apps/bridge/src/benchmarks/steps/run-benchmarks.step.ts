import { Injectable } from '@nestjs/common';

import type { SagaContext } from '../../saga-framework/saga.types';

interface BenchmarkServiceLike {
  runBenchmarks(args: {
    deviceId: string;
    benchmarkType: unknown;
    duration: unknown;
  }): Promise<Record<string, unknown> | null>;
}

interface BenchmarkServiceFactoryLike {
  create(jobId: string, options?: { signal?: AbortSignal; workId?: string }): Promise<BenchmarkServiceLike>;
}

@Injectable()
export class RunBenchmarksStep {
  constructor(private readonly factory: BenchmarkServiceFactoryLike) {}

  async execute(ctx: SagaContext): Promise<Record<string, unknown> | null> {
    const ccResult = (ctx.stepResults.check_cc_mode as Record<string, unknown> | undefined) ?? {};
    if (ccResult.skip_benchmarks) {
      return { skipped: true, reason: 'Confidential Compute enabled' };
    }

    const payload = ctx.payload;
    const service = await this.factory.create(ctx.jobId, { signal: ctx.signal, workId: ctx.workId });
    return service.runBenchmarks({
      deviceId: String(ctx.deviceId),
      benchmarkType: 'benchmark_type' in payload ? payload.benchmark_type : 'all',
      duration: 'duration' in payload ? payload.duration : '30m',
    });
  }
}
