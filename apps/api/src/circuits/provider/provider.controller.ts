import { Controller, UseGuards } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { SupplyOrganizationGuard } from 'src/auth/guards/supply-organization.guard';
import { AuditAction } from 'src/event-log/audit-action.decorator';
import { ProviderService } from './provider.service';

@UseGuards(SupplyOrganizationGuard)
@Controller()
export class ProviderController {
  constructor(private readonly service: ProviderService) {}

  @TsRestHandler(contract.listProviders)
  async list() {
    return tsRestHandler(contract.listProviders, async ({ query }) => ({
      status: 200,
      body: await this.service.list(query.search),
    }));
  }

  @TsRestHandler(contract.getProvider)
  async getById() {
    return tsRestHandler(contract.getProvider, async ({ params }) => ({
      status: 200,
      body: await this.service.findById(params.id),
    }));
  }

  @AuditAction({ actionKey: 'provider.created', resource: 'provider', action: 'create' })
  @TsRestHandler(contract.createProvider)
  async create() {
    return tsRestHandler(contract.createProvider, async ({ body }) => ({
      status: 201,
      body: await this.service.create({
        name: body.name,
        slug: body.slug,
        description: body.description,
        comments: body.comments,
      }),
    }));
  }

  @AuditAction({ actionKey: 'provider.updated', resource: 'provider', action: 'update' })
  @TsRestHandler(contract.updateProvider)
  async update() {
    return tsRestHandler(contract.updateProvider, async ({ params, body }) => ({
      status: 200,
      body: await this.service.update(params.id, body),
    }));
  }

  @AuditAction({ actionKey: 'provider.deleted', resource: 'provider', action: 'delete' })
  @TsRestHandler(contract.deleteProvider)
  async delete() {
    return tsRestHandler(contract.deleteProvider, async ({ params }) => {
      await this.service.delete(params.id);
      return { status: 204 as const, body: undefined };
    });
  }
}
