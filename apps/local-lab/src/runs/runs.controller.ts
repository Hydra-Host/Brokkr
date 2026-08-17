import { Controller, Param, Sse } from '@nestjs/common';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { type Observable } from 'rxjs';

import { contract } from '../contract';
import { runLogFrames, type RunLogFrame } from '../runner/run-log-stream';
import { RunsService } from './runs.service';

@Controller()
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  @TsRestHandler(contract.listRuns)
  list() {
    return tsRestHandler(contract.listRuns, async ({ query }) => ({
      status: 200 as const,
      body: this.runs.list(query),
    }));
  }

  @TsRestHandler(contract.getRun)
  get() {
    return tsRestHandler(contract.getRun, async ({ params }) => ({
      status: 200 as const,
      body: this.runs.get(params.runId),
    }));
  }

  @TsRestHandler(contract.cancelRun)
  cancel() {
    return tsRestHandler(contract.cancelRun, async ({ params }) => ({
      status: 200 as const,
      body: this.runs.cancel(params.runId),
    }));
  }

  @Sse('api/runs/:runId/stream')
  stream(@Param('runId') runId: string): Observable<RunLogFrame> {
    return runLogFrames(this.runs.stream(runId));
  }
}
