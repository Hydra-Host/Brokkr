import { Controller } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { JobsService } from './jobs.service';

@Controller()
export class JobsController {
  constructor(private readonly jobsService: JobsService) {}

  @TsRestHandler(contract.listLifecycleJobs)
  async listLifecycleJobs() {
    return tsRestHandler(contract.listLifecycleJobs, async ({ query }) => ({
      status: 200 as const,
      body: await this.jobsService.list(query),
    }));
  }
}
