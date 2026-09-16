import { Controller } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { JobLogsService } from './job-logs.service';

@Controller()
export class JobLogsController {
  constructor(private readonly service: JobLogsService) {}

  @TsRestHandler(contract.getJobLogs)
  getJobLogs() {
    return tsRestHandler(contract.getJobLogs, async ({ params, query }) => ({
      status: 200,
      body: await this.service.getJobLogs(params.jobId, query),
    }));
  }

  @TsRestHandler(contract.listDeviceJobs)
  listDeviceJobs() {
    return tsRestHandler(contract.listDeviceJobs, async ({ params }) => ({
      status: 200,
      body: await this.service.listDeviceJobs(params.deviceId),
    }));
  }
}
