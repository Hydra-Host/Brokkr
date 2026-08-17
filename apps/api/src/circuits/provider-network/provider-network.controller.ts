import { Controller, UseGuards } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { SupplyOrganizationGuard } from 'src/auth/guards/supply-organization.guard';
import { AuditAction } from 'src/event-log/audit-action.decorator';
import { ProviderNetworkService } from './provider-network.service';

@UseGuards(SupplyOrganizationGuard)
@Controller()
export class ProviderNetworkController {
  constructor(private readonly service: ProviderNetworkService) {}

  @TsRestHandler(contract.listProviderNetworks)
  async list() {
    return tsRestHandler(contract.listProviderNetworks, async ({ query }) => ({
      status: 200,
      body: await this.service.list({ providerId: query.providerId, search: query.search }),
    }));
  }

  @TsRestHandler(contract.getProviderNetwork)
  async getById() {
    return tsRestHandler(contract.getProviderNetwork, async ({ params }) => ({
      status: 200,
      body: await this.service.findById(params.id),
    }));
  }

  @AuditAction({ actionKey: 'provider-network.created', resource: 'provider-network', action: 'create' })
  @TsRestHandler(contract.createProviderNetwork)
  async create() {
    return tsRestHandler(contract.createProviderNetwork, async ({ body }) => ({
      status: 201,
      body: await this.service.create({
        name: body.name,
        description: body.description,
        comments: body.comments,
        providerId: body.providerId,
      }),
    }));
  }

  @AuditAction({ actionKey: 'provider-network.updated', resource: 'provider-network', action: 'update' })
  @TsRestHandler(contract.updateProviderNetwork)
  async update() {
    return tsRestHandler(contract.updateProviderNetwork, async ({ params, body }) => ({
      status: 200,
      body: await this.service.update(params.id, body),
    }));
  }

  @AuditAction({ actionKey: 'provider-network.deleted', resource: 'provider-network', action: 'delete' })
  @TsRestHandler(contract.deleteProviderNetwork)
  async delete() {
    return tsRestHandler(contract.deleteProviderNetwork, async ({ params }) => {
      await this.service.delete(params.id);
      return { status: 204 as const, body: undefined };
    });
  }
}
