import { Controller } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { DeploymentJobsService } from '../services/deployment-jobs.service';

@Controller()
export class DeploymentJobsController {
  constructor(private readonly deploymentJobsService: DeploymentJobsService) {}

  @TsRestHandler(contract.listDeploymentJobs)
  async listDeploymentJobs() {
    return tsRestHandler(contract.listDeploymentJobs, async ({ params, query }) => {
      const page = await this.deploymentJobsService.list(params.id, query);
      return { status: 200 as const, body: page };
    });
  }

  @TsRestHandler(contract.getDeploymentJobEvents)
  async getDeploymentJobEvents() {
    return tsRestHandler(contract.getDeploymentJobEvents, async ({ params }) => {
      const events = await this.deploymentJobsService.events(params.id, params.jobId);
      return { status: 200 as const, body: events };
    });
  }
}
