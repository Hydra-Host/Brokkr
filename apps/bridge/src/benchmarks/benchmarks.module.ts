import { Module, type OnModuleInit } from '@nestjs/common';

import { Dispatcher } from '../agent/dispatch/dispatcher.service';
import type { ResultsService } from '../bullmq/results.service';
import { BULLMQ_RESULTS_SERVICE } from '../composition/composition-tokens';
import { ContextLogger } from '../logger/logger.service';
import { registerSagaDef } from '../saga-framework/saga-registry';

import { BenchmarkService, type BenchmarkDispatchFn, type BenchmarkResultProducer } from './benchmark.service';
import { buildBenchmarksSaga } from './benchmarks.workflow';
import { CheckCcModeStep } from './steps/check-cc-mode.step';
import { ReportResultsStep } from './steps/report-results.step';
import { RunBenchmarksStep } from './steps/run-benchmarks.step';

function buildBenchmarkFactory(
  dispatcher: Dispatcher,
  results: ResultsService,
  logger: ContextLogger,
): {
  create: (jobId: string, options?: { signal?: AbortSignal; workId?: string }) => Promise<BenchmarkService>;
} {
  const producer: BenchmarkResultProducer = {
    enqueueResult: (args) => results.enqueueResult(args),
  };
  return {
    create: async (jobId: string, sagaOptions?: { signal?: AbortSignal; workId?: string }) => {
      let dispatchIndex = 0;
      const dispatch: BenchmarkDispatchFn = (deviceId, operation, input, options) =>
        dispatcher.dispatchTyped(deviceId, operation, input, {
          jobId: options?.jobId ?? null,
          timeoutS: options?.timeoutS ?? null,
          signal: sagaOptions?.signal,
          workId: sagaOptions?.workId === undefined ? undefined : `${sagaOptions.workId}:${dispatchIndex++}`,
        });
      return new BenchmarkService(jobId, dispatch, producer, logger);
    },
  };
}

@Module({
  providers: [
    {
      provide: CheckCcModeStep,
      useFactory: (dispatcher: Dispatcher, results: ResultsService, logger: ContextLogger) =>
        new CheckCcModeStep(buildBenchmarkFactory(dispatcher, results, logger)),
      inject: [Dispatcher, BULLMQ_RESULTS_SERVICE, ContextLogger],
    },
    {
      provide: RunBenchmarksStep,
      useFactory: (dispatcher: Dispatcher, results: ResultsService, logger: ContextLogger) =>
        new RunBenchmarksStep(buildBenchmarkFactory(dispatcher, results, logger)),
      inject: [Dispatcher, BULLMQ_RESULTS_SERVICE, ContextLogger],
    },
    {
      provide: ReportResultsStep,
      useFactory: (dispatcher: Dispatcher, results: ResultsService, logger: ContextLogger) =>
        new ReportResultsStep(buildBenchmarkFactory(dispatcher, results, logger)),
      inject: [Dispatcher, BULLMQ_RESULTS_SERVICE, ContextLogger],
    },
  ],
  exports: [CheckCcModeStep, RunBenchmarksStep, ReportResultsStep],
})
export class BenchmarksModule implements OnModuleInit {
  constructor(
    private readonly checkCcMode: CheckCcModeStep,
    private readonly runBenchmarks: RunBenchmarksStep,
    private readonly reportResults: ReportResultsStep,
  ) {}

  onModuleInit(): void {
    registerSagaDef(
      buildBenchmarksSaga({
        checkCcMode: this.checkCcMode,
        runBenchmarks: this.runBenchmarks,
        reportResults: this.reportResults,
      }),
    );
  }
}
