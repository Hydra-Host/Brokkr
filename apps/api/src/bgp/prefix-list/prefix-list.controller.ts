import { Controller, UseGuards } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { SupplyOrganizationGuard } from 'src/auth/guards/supply-organization.guard';
import { PrefixListService } from './prefix-list.service';

@UseGuards(SupplyOrganizationGuard)
@Controller()
export class PrefixListController {
  constructor(private readonly service: PrefixListService) {}

  @TsRestHandler(contract.listPrefixLists)
  async list() {
    return tsRestHandler(contract.listPrefixLists, async ({ query }) => ({
      status: 200,
      body: await this.service.list({ family: query.family, search: query.search }),
    }));
  }

  @TsRestHandler(contract.getPrefixList)
  async getById() {
    return tsRestHandler(contract.getPrefixList, async ({ params }) => ({
      status: 200,
      body: await this.service.findById(params.id),
    }));
  }

  @TsRestHandler(contract.createPrefixList)
  async create() {
    return tsRestHandler(contract.createPrefixList, async ({ body }) => ({
      status: 201,
      body: await this.service.create({
        name: body.name,
        description: body.description,
        family: body.family,
      }),
    }));
  }

  @TsRestHandler(contract.updatePrefixList)
  async update() {
    return tsRestHandler(contract.updatePrefixList, async ({ params, body }) => ({
      status: 200,
      body: await this.service.update(params.id, body),
    }));
  }

  @TsRestHandler(contract.deletePrefixList)
  async delete() {
    return tsRestHandler(contract.deletePrefixList, async ({ params }) => {
      await this.service.delete(params.id);
      return { status: 204 as const, body: undefined };
    });
  }
}
