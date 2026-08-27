import { Controller, Get, Req, Res } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import type { Request, Response } from 'express';
import { EventLogExportService } from './event-log-export.service';
import { toExportSink } from './event-log-export.sink';
import { EventLogService } from './event-log.service';

@Controller()
export class EventLogController {
  constructor(
    private readonly service: EventLogService,
    private readonly exportService: EventLogExportService,
  ) {}

  @TsRestHandler(contract.listEventLog)
  async listEventLog() {
    return tsRestHandler(contract.listEventLog, async ({ query }) => ({
      status: 200 as const,
      body: await this.service.list(query),
    }));
  }

  /** Not a `@TsRestHandler`: one branch streams text/csv, and ts-rest declares a single body schema
   *  per status. The contract still declares the route, and the service validates the query against it. */
  @Get(contract.exportEventLog.path)
  async exportEventLog(@Req() req: Request, @Res() res: Response) {
    await this.exportService.export(req.query, toExportSink(res));
  }
}
