import { Controller, UseGuards } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { SupplyOrganizationGuard } from 'src/auth/guards/supply-organization.guard';
import { GatewayService } from './gateway.service';

@UseGuards(SupplyOrganizationGuard)
@Controller()
export class GatewayController {
  constructor(private readonly service: GatewayService) {}

  @TsRestHandler(contract.listGateways)
  async list() {
    return tsRestHandler(contract.listGateways, async ({ query }) => ({
      status: 200,
      body: await this.service.list(query),
    }));
  }

  @TsRestHandler(contract.getGateway)
  async getById() {
    return tsRestHandler(contract.getGateway, async ({ params }) => ({
      status: 200,
      body: await this.service.findById(params.id),
    }));
  }

  @TsRestHandler(contract.createGateway)
  async create() {
    return tsRestHandler(contract.createGateway, async ({ body }) => ({
      status: 201,
      body: await this.service.create({
        gatewayIpId: body.gatewayIpId,
        prefixId: body.prefixId,
        vrfId: body.vrfId,
        routingPriority: body.routingPriority,
      }),
    }));
  }

  @TsRestHandler(contract.updateGateway)
  async update() {
    return tsRestHandler(contract.updateGateway, async ({ params, body }) => ({
      status: 200,
      body: await this.service.update(params.id, body),
    }));
  }

  @TsRestHandler(contract.deleteGateway)
  async delete() {
    return tsRestHandler(contract.deleteGateway, async ({ params }) => {
      await this.service.delete(params.id);
      return { status: 204 as const, body: undefined };
    });
  }
}
