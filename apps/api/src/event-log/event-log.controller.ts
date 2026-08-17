import { Controller } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { EventLogService } from './event-log.service';

@Controller()
export class EventLogController {
  constructor(private readonly service: EventLogService) {}

  @TsRestHandler(contract.listEventLog)
  async listEventLog() {
    return tsRestHandler(contract.listEventLog, async ({ query }) => ({
      status: 200 as const,
      body: await this.service.list(query),
    }));
  }
}
