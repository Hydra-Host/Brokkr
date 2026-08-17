import { Controller, Get, Param, Query, Sse, StreamableFile } from '@nestjs/common';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { concat, from, map, Observable, of } from 'rxjs';

import { LabRoute } from '../common/lab-route';
import { contract, type StreamDoneEvent, type TestEvent } from '../contract';
import { DONE_FRAME } from '../runner/run-log-stream';
import { TestService } from './test.service';

@Controller()
export class TestController {
  constructor(private readonly tests: TestService) {}

  @TsRestHandler(contract.listTests)
  list() {
    return tsRestHandler(contract.listTests, async () => ({ status: 200 as const, body: this.tests.scenarios() }));
  }

  @TsRestHandler(contract.startTest)
  @LabRoute({ exposure: 'loopback-only' })
  start() {
    return tsRestHandler(contract.startTest, async ({ body }) => {
      const runId = this.tests.start(body.scenarioId, body.nodeIndex, {
        base: body.base,
        customizations: body.customizations,
        cloudInit: body.cloudInit,
        rescueOs: body.rescueOs,
        baseOses: body.baseOses,
        ipxeUrl: body.ipxeUrl,
        diskLayouts: body.diskLayouts,
        steps: body.steps,
        plan: body.plan,
      });
      return { status: 200 as const, body: { runId } };
    });
  }

  @TsRestHandler(contract.getDiskLayouts)
  diskLayouts() {
    return tsRestHandler(contract.getDiskLayouts, async ({ params }) => ({
      status: 200 as const,
      body: await this.tests.diskLayouts(params.nodeIndex),
    }));
  }

  @TsRestHandler(contract.getLayerCatalog)
  layers() {
    return tsRestHandler(contract.getLayerCatalog, async ({ params }) => ({
      status: 200 as const,
      body: await this.tests.layerCatalog(params.nodeIndex),
    }));
  }

  @TsRestHandler(contract.getPlanCatalog)
  planCatalog() {
    return tsRestHandler(contract.getPlanCatalog, async () => ({
      status: 200 as const,
      body: this.tests.planCatalog(),
    }));
  }

  @TsRestHandler(contract.purgeTestRuns)
  @LabRoute({ exposure: 'loopback-only' })
  purge() {
    return tsRestHandler(contract.purgeTestRuns, async ({ body }) => ({
      status: 200 as const,
      body: { purged: this.tests.purge(body.runId) },
    }));
  }

  @TsRestHandler(contract.postTestEvent)
  postEvent() {
    return tsRestHandler(contract.postTestEvent, async ({ params, body }) => {
      this.tests.addEvent(params.runId, body);
      return { status: 204 as const, body: undefined };
    });
  }

  @TsRestHandler(contract.listTestEvents)
  events() {
    return tsRestHandler(contract.listTestEvents, async ({ params }) => ({
      status: 200 as const,
      body: this.tests.listEvents(params.runId),
    }));
  }

  @Sse('api/tests/runs/:runId/events/stream')
  eventStream(@Param('runId') runId: string): Observable<{ data: TestEvent | StreamDoneEvent }> {
    const { backlog, live$ } = this.tests.eventStream(runId);
    return concat(
      from(backlog).pipe(map((evt) => ({ data: evt }))),
      live$.pipe(map((evt) => ({ data: evt }))),
      of(DONE_FRAME),
    );
  }

  @TsRestHandler(contract.getTestResult)
  result() {
    return tsRestHandler(contract.getTestResult, async ({ params }) => ({
      status: 200 as const,
      body: this.tests.result(params.runId),
    }));
  }

  @Get('api/tests/runs/:runId/attachment')
  attachment(@Param('runId') runId: string, @Query('source') source: string): StreamableFile {
    return this.tests.attachmentStream(runId, source);
  }
}
