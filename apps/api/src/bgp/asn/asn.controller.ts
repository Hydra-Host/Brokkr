import { Controller, UseGuards } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { SupplyOrganizationGuard } from 'src/auth/guards/supply-organization.guard';
import { AsnService } from './asn.service';

@UseGuards(SupplyOrganizationGuard)
@Controller()
export class AsnController {
  constructor(private readonly service: AsnService) {}

  @TsRestHandler(contract.listAsns)
  async list() {
    return tsRestHandler(contract.listAsns, async () => ({
      status: 200,
      body: await this.service.list(),
    }));
  }

  @TsRestHandler(contract.getAsn)
  async getById() {
    return tsRestHandler(contract.getAsn, async ({ params }) => ({
      status: 200,
      body: await this.service.findById(params.id),
    }));
  }

  @TsRestHandler(contract.createAsn)
  async create() {
    return tsRestHandler(contract.createAsn, async ({ body }) => ({
      status: 201,
      body: await this.service.create(body),
    }));
  }

  @TsRestHandler(contract.updateAsn)
  async update() {
    return tsRestHandler(contract.updateAsn, async ({ params, body }) => ({
      status: 200,
      body: await this.service.update(params.id, body),
    }));
  }

  @TsRestHandler(contract.deleteAsn)
  async delete() {
    return tsRestHandler(contract.deleteAsn, async ({ params }) => {
      await this.service.delete(params.id);
      return { status: 204 as const, body: undefined };
    });
  }
}
