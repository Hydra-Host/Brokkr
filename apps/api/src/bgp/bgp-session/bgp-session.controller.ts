import { Controller, UseGuards } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { SupplyOrganizationGuard } from 'src/auth/guards/supply-organization.guard';
import { BgpSessionService } from './bgp-session.service';

@UseGuards(SupplyOrganizationGuard)
@Controller()
export class BgpSessionController {
  constructor(private readonly service: BgpSessionService) {}

  @TsRestHandler(contract.listBgpSessions)
  async list() {
    return tsRestHandler(contract.listBgpSessions, async ({ query }) => ({
      status: 200,
      body: await this.service.list({
        deviceId: query.deviceId,
        peerGroupId: query.peerGroupId,
        status: query.status,
        search: query.search,
      }),
    }));
  }

  @TsRestHandler(contract.getBgpSession)
  async getById() {
    return tsRestHandler(contract.getBgpSession, async ({ params }) => ({
      status: 200,
      body: await this.service.findById(params.id),
    }));
  }

  @TsRestHandler(contract.createBgpSession)
  async create() {
    return tsRestHandler(contract.createBgpSession, async ({ body }) => ({
      status: 201,
      body: await this.service.create({
        name: body.name,
        status: body.status,
        description: body.description,
        deviceId: body.deviceId,
        localAsnId: body.localAsnId,
        remoteAsnId: body.remoteAsnId,
        localAddressId: body.localAddressId,
        remoteAddressId: body.remoteAddressId,
        peerGroupId: body.peerGroupId,
        prefixListInId: body.prefixListInId,
        prefixListOutId: body.prefixListOutId,
      }),
    }));
  }

  @TsRestHandler(contract.updateBgpSession)
  async update() {
    return tsRestHandler(contract.updateBgpSession, async ({ params, body }) => ({
      status: 200,
      body: await this.service.update(params.id, body),
    }));
  }

  @TsRestHandler(contract.deleteBgpSession)
  async delete() {
    return tsRestHandler(contract.deleteBgpSession, async ({ params }) => {
      await this.service.delete(params.id);
      return { status: 204 as const, body: undefined };
    });
  }
}
