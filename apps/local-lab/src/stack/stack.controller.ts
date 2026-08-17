import { Controller, Param, Sse } from '@nestjs/common';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { map, Observable } from 'rxjs';

import { getErrorMessage } from '../common/errors';
import { LabRoute } from '../common/lab-route';
import { contract } from '../contract';
import { StackRestartService } from '../services/stack-restart.service';
import { InitTasksService } from './init-tasks.service';
import { ActiveSagaConflictException, StackService } from './stack.service';

@Controller()
export class StackController {
  constructor(
    private readonly stack: StackService,
    private readonly stackRestart: StackRestartService,
    private readonly initTasks: InitTasksService,
  ) {}

  @TsRestHandler(contract.listStackOps)
  listOps() {
    return tsRestHandler(contract.listStackOps, async () => ({ status: 200 as const, body: this.stack.ops() }));
  }

  @TsRestHandler(contract.startStackRun)
  @LabRoute({ exposure: 'loopback-only' })
  startRun() {
    return tsRestHandler(contract.startStackRun, async ({ body }) => {
      try {
        return {
          status: 200 as const,
          body: { runId: await this.stack.startRun(body.opId, body.allowDataLoss, body.force) },
        };
      } catch (e) {
        // the active-saga 409 carries a structured payload (activeJobs) that the flat { error }
        // global filter would drop — map just this one; everything else falls through to the filter.
        if (e instanceof ActiveSagaConflictException)
          return { status: 409 as const, body: { error: getErrorMessage(e), activeJobs: e.activeJobs } };
        throw e;
      }
    });
  }

  @TsRestHandler(contract.getStackState)
  state() {
    return tsRestHandler(contract.getStackState, async () => ({
      status: 200 as const,
      body: await this.stack.state(),
    }));
  }

  @TsRestHandler(contract.getRestartState)
  restartState() {
    return tsRestHandler(contract.getRestartState, async () => ({
      status: 200 as const,
      body: this.stackRestart.restartState(),
    }));
  }

  @TsRestHandler(contract.controlDatastore)
  @LabRoute({ exposure: 'loopback-only' })
  controlDatastore() {
    return tsRestHandler(contract.controlDatastore, async ({ body }) => ({
      status: 200 as const,
      body: await this.stack.controlDatastore(body.id, body.action),
    }));
  }

  @TsRestHandler(contract.getInitTasks)
  initTasksList() {
    return tsRestHandler(contract.getInitTasks, async () => ({
      status: 200 as const,
      body: this.initTasks.list(),
    }));
  }

  @Sse('api/stack/datastores/:id/log')
  datastoreLog(@Param('id') id: string): Observable<{ data: { line: string } }> {
    return this.stack.streamDatastoreLog(id).pipe(map((line) => ({ data: { line } })));
  }

  @Sse('api/stack/init/:name/log')
  initTaskLog(@Param('name') name: string): Observable<{ data: { line: string } }> {
    return this.initTasks.streamLog(name).pipe(map((line) => ({ data: { line } })));
  }
}
