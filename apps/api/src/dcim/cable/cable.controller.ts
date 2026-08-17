import { Controller, UseGuards } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { CableSide } from '@repo/database';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { SupplyOrganizationGuard } from 'src/auth/guards/supply-organization.guard';
import { CableService } from './cable.service';

@UseGuards(SupplyOrganizationGuard)
@Controller()
export class CableController {
  constructor(private readonly service: CableService) {}

  @TsRestHandler(contract.listDcimCables)
  async list() {
    return tsRestHandler(contract.listDcimCables, async ({ query }) => ({
      status: 200,
      body: await this.service.list(query),
    }));
  }

  @TsRestHandler(contract.getDcimCable)
  async getById() {
    return tsRestHandler(contract.getDcimCable, async ({ params }) => ({
      status: 200,
      body: await this.service.findById(params.id),
    }));
  }

  @TsRestHandler(contract.createDcimCable)
  async create() {
    return tsRestHandler(contract.createDcimCable, async ({ body }) => {
      const { aTermination, bTermination, ...cable } = body;
      return {
        status: 201,
        body: await this.service.create({
          ...cable,
          terminations: [
            { cableSide: CableSide.A, terminationType: aTermination.type, terminationId: aTermination.id },
            { cableSide: CableSide.B, terminationType: bTermination.type, terminationId: bTermination.id },
          ],
        }),
      };
    });
  }

  @TsRestHandler(contract.updateDcimCable)
  async update() {
    return tsRestHandler(contract.updateDcimCable, async ({ params, body }) => ({
      status: 200,
      body: await this.service.update(params.id, body),
    }));
  }

  @TsRestHandler(contract.deleteDcimCable)
  async delete() {
    return tsRestHandler(contract.deleteDcimCable, async ({ params }) => {
      await this.service.delete(params.id);
      return { status: 204 as const, body: undefined };
    });
  }
}
