import { Controller } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { LifecycleRequestsService } from '../services/lifecycle-requests.service';

@Controller()
export class LifecycleRequestsController {
  constructor(private readonly lifecycleRequestsService: LifecycleRequestsService) {}

  @TsRestHandler(contract.getLifecycleRequests)
  async getLifecycleRequests() {
    return tsRestHandler(contract.getLifecycleRequests, async ({ params }) => {
      const data = await this.lifecycleRequestsService.getLifecycleRequestsForDeployment(params.id);
      return { status: 200 as const, body: data };
    });
  }

  @TsRestHandler(contract.approveLifecycleRequest)
  async approveLifecycleRequest() {
    return tsRestHandler(contract.approveLifecycleRequest, async ({ params }) => {
      const result = await this.lifecycleRequestsService.approveLifecycleRequest(params.id, params.requestId);
      return { status: 200 as const, body: result };
    });
  }

  @TsRestHandler(contract.rejectLifecycleRequest)
  async rejectLifecycleRequest() {
    return tsRestHandler(contract.rejectLifecycleRequest, async ({ params }) => {
      const result = await this.lifecycleRequestsService.rejectLifecycleRequest(params.id, params.requestId);
      return { status: 200 as const, body: result };
    });
  }
}
