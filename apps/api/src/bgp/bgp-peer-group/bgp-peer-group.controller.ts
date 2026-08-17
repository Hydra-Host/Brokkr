import { Controller, UseGuards } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { SupplyOrganizationGuard } from 'src/auth/guards/supply-organization.guard';
import { BgpPeerGroupService } from './bgp-peer-group.service';

@UseGuards(SupplyOrganizationGuard)
@Controller()
export class BgpPeerGroupController {
  constructor(private readonly service: BgpPeerGroupService) {}

  @TsRestHandler(contract.listBgpPeerGroups)
  async list() {
    return tsRestHandler(contract.listBgpPeerGroups, async ({ query }) => ({
      status: 200,
      body: await this.service.list(query.search),
    }));
  }

  @TsRestHandler(contract.getBgpPeerGroup)
  async getById() {
    return tsRestHandler(contract.getBgpPeerGroup, async ({ params }) => ({
      status: 200,
      body: await this.service.findById(params.id),
    }));
  }

  @TsRestHandler(contract.createBgpPeerGroup)
  async create() {
    return tsRestHandler(contract.createBgpPeerGroup, async ({ body }) => ({
      status: 201,
      body: await this.service.create({
        name: body.name,
        description: body.description,
      }),
    }));
  }

  @TsRestHandler(contract.updateBgpPeerGroup)
  async update() {
    return tsRestHandler(contract.updateBgpPeerGroup, async ({ params, body }) => ({
      status: 200,
      body: await this.service.update(params.id, body),
    }));
  }

  @TsRestHandler(contract.deleteBgpPeerGroup)
  async delete() {
    return tsRestHandler(contract.deleteBgpPeerGroup, async ({ params }) => {
      await this.service.delete(params.id);
      return { status: 204 as const, body: undefined };
    });
  }
}
