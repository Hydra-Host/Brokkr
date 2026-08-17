import type { SagaContext, SagaDef, SagaStepExecutor } from '../saga-framework/saga.types';

export interface BenchmarksSagaStepServices {
  checkCcMode: SagaStepExecutor;
  runBenchmarks: SagaStepExecutor;
  reportResults: SagaStepExecutor;
}

export function buildBenchmarksSaga(steps: BenchmarksSagaStepServices): SagaDef {
  return {
    name: 'benchmarks',
    steps: [
      {
        name: 'check_cc_mode',
        operation: 'Check Confidential Compute mode',
        execute: (ctx: SagaContext) => steps.checkCcMode.execute(ctx),
      },
      {
        name: 'run_benchmarks',
        operation: 'Run GPU burn-in and NCCL tests',
        execute: (ctx: SagaContext) => steps.runBenchmarks.execute(ctx),
        maxAttempts: 2,
        recovery: [{ rewindTo: 'run_benchmarks', description: 'Retry benchmarks' }],
      },
      {
        name: 'report_results',
        operation: 'Report results to hub',
        execute: (ctx: SagaContext) => steps.reportResults.execute(ctx),
      },
    ],
  };
}
