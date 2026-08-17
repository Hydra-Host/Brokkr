import { Controller, UseGuards } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { SupplyOrganizationGuard } from 'src/auth/guards/supply-organization.guard';
import { CircuitService } from './circuit.service';

@UseGuards(SupplyOrganizationGuard)
@Controller()
export class CircuitController {
  constructor(private readonly service: CircuitService) {}

  @TsRestHandler(contract.listCircuits)
  async list() {
    return tsRestHandler(contract.listCircuits, async ({ query }) => ({
      status: 200,
      body: await this.service.list({
        providerId: query.providerId,
        circuitTypeId: query.circuitTypeId,
        status: query.status,
        search: query.search,
      }),
    }));
  }

  @TsRestHandler(contract.getCircuit)
  async getById() {
    return tsRestHandler(contract.getCircuit, async ({ params }) => ({
      status: 200,
      body: await this.service.findById(params.id),
    }));
  }

  @TsRestHandler(contract.createCircuit)
  async create() {
    return tsRestHandler(contract.createCircuit, async ({ body }) => ({
      status: 201,
      body: await this.service.create({
        cid: body.cid,
        status: body.status,
        installDate: body.installDate,
        terminationDate: body.terminationDate,
        commitRate: body.commitRate,
        description: body.description,
        comments: body.comments,
        providerId: body.providerId,
        circuitTypeId: body.circuitTypeId,
      }),
    }));
  }

  @TsRestHandler(contract.updateCircuit)
  async update() {
    return tsRestHandler(contract.updateCircuit, async ({ params, body }) => ({
      status: 200,
      body: await this.service.update(params.id, body),
    }));
  }

  @TsRestHandler(contract.deleteCircuit)
  async delete() {
    return tsRestHandler(contract.deleteCircuit, async ({ params }) => {
      await this.service.delete(params.id);
      return { status: 204 as const, body: undefined };
    });
  }
}
