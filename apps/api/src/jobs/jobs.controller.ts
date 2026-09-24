import { Controller } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { JobsService } from './jobs.service';
import { LifecycleJobEventsService } from './lifecycle-job-events.service';

@Controller()
export class JobsController {
  constructor(
    private readonly jobsService: JobsService,
    private readonly jobEvents: LifecycleJobEventsService,
  ) {}

  @TsRestHandler(contract.listLifecycleJobs)
  async listLifecycleJobs() {
    return tsRestHandler(contract.listLifecycleJobs, async ({ query }) => ({
      status: 200 as const,
      body: await this.jobsService.list(query),
    }));
  }

  @TsRestHandler(contract.listLifecycleJobEvents)
  async listLifecycleJobEvents() {
    return tsRestHandler(contract.listLifecycleJobEvents, async ({ params }) => ({
      status: 200 as const,
      body: await this.jobEvents.list(params.jobId),
    }));
  }
}
