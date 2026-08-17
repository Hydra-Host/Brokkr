import { Controller, UseGuards } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { InstanceOperatorGuard } from 'src/auth/guards/instance-operator.guard';
import { InterruptibleApprovalsService } from './interruptible-approvals.service';

@Controller()
@UseGuards(InstanceOperatorGuard)
export class InterruptibleApprovalsController {
  constructor(private readonly interruptibleApprovalsService: InterruptibleApprovalsService) {}

  @TsRestHandler(contract.listPendingInterruptibleEvictions)
  async listPending() {
    return tsRestHandler(contract.listPendingInterruptibleEvictions, async () => {
      const data = await this.interruptibleApprovalsService.listPending();
      return { status: 200 as const, body: data };
    });
  }

  @TsRestHandler(contract.authorizeInterruptibleEviction)
  async authorize() {
    return tsRestHandler(contract.authorizeInterruptibleEviction, async ({ params }) => {
      const result = await this.interruptibleApprovalsService.authorize(params.requestId);
      return { status: 200 as const, body: result };
    });
  }

  @TsRestHandler(contract.rejectInterruptibleEviction)
  async reject() {
    return tsRestHandler(contract.rejectInterruptibleEviction, async ({ params }) => {
      const result = await this.interruptibleApprovalsService.reject(params.requestId);
      return { status: 200 as const, body: result };
    });
  }
}
