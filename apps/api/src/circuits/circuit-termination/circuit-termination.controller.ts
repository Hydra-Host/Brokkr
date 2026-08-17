import { Controller, UseGuards } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { SupplyOrganizationGuard } from 'src/auth/guards/supply-organization.guard';
import { CircuitTerminationService } from './circuit-termination.service';

@UseGuards(SupplyOrganizationGuard)
@Controller()
export class CircuitTerminationController {
  constructor(private readonly service: CircuitTerminationService) {}

  @TsRestHandler(contract.listCircuitTerminations)
  async list() {
    return tsRestHandler(contract.listCircuitTerminations, async ({ query }) => ({
      status: 200,
      body: await this.service.list({
        circuitId: query.circuitId,
        zoneId: query.zoneId,
        search: query.search,
      }),
    }));
  }

  @TsRestHandler(contract.getCircuitTermination)
  async getById() {
    return tsRestHandler(contract.getCircuitTermination, async ({ params }) => ({
      status: 200,
      body: await this.service.findById(params.id),
    }));
  }

  @TsRestHandler(contract.createCircuitTermination)
  async create() {
    return tsRestHandler(contract.createCircuitTermination, async ({ body }) => ({
      status: 201,
      body: await this.service.create({
        termSide: body.termSide,
        portSpeed: body.portSpeed,
        upstreamSpeed: body.upstreamSpeed,
        xconnectId: body.xconnectId,
        description: body.description,
        circuitId: body.circuitId,
        zoneId: body.zoneId,
      }),
    }));
  }

  @TsRestHandler(contract.updateCircuitTermination)
  async update() {
    return tsRestHandler(contract.updateCircuitTermination, async ({ params, body }) => ({
      status: 200,
      body: await this.service.update(params.id, body),
    }));
  }

  @TsRestHandler(contract.deleteCircuitTermination)
  async delete() {
    return tsRestHandler(contract.deleteCircuitTermination, async ({ params }) => {
      await this.service.delete(params.id);
      return { status: 204 as const, body: undefined };
    });
  }
}
