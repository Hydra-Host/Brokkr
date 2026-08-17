import { Controller, UseGuards } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { SupplyOrganizationGuard } from 'src/auth/guards/supply-organization.guard';
import { RackElevationService } from './rack-elevation.service';
import { RackService } from './rack.service';

@UseGuards(SupplyOrganizationGuard)
@Controller()
export class RackController {
  constructor(
    private readonly service: RackService,
    private readonly elevationService: RackElevationService,
  ) {}

  @TsRestHandler(contract.listDcimRacks)
  async list() {
    return tsRestHandler(contract.listDcimRacks, async ({ query }) => ({
      status: 200,
      body: await this.service.list(query),
    }));
  }

  @TsRestHandler(contract.getDcimRack)
  async getById() {
    return tsRestHandler(contract.getDcimRack, async ({ params }) => ({
      status: 200,
      body: await this.service.findById(params.id),
    }));
  }

  @TsRestHandler(contract.createDcimRack)
  async create() {
    return tsRestHandler(contract.createDcimRack, async ({ body }) => ({
      status: 201,
      body: await this.service.create({
        name: body.name ?? '',
        zoneId: body.zoneId ?? '',
        status: body.status,
        role: body.role,
        heightU: body.heightU,
        startingUnit: body.startingUnit,
        description: body.description,
        serial: body.serial,
        assetTag: body.assetTag,
      }),
    }));
  }

  @TsRestHandler(contract.updateDcimRack)
  async update() {
    return tsRestHandler(contract.updateDcimRack, async ({ params, body }) => ({
      status: 200,
      body: await this.service.update(params.id, body),
    }));
  }

  @TsRestHandler(contract.deleteDcimRack)
  async delete() {
    return tsRestHandler(contract.deleteDcimRack, async ({ params }) => {
      await this.service.delete(params.id);
      return { status: 204 as const, body: undefined };
    });
  }

  @TsRestHandler(contract.getDcimRackElevation)
  async getElevation() {
    return tsRestHandler(contract.getDcimRackElevation, async ({ params, query }) => ({
      status: 200,
      body: await this.elevationService.getElevation(params.id, query.face),
    }));
  }
}
