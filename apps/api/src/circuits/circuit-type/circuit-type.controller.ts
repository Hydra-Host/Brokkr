import { Controller, UseGuards } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { SupplyOrganizationGuard } from 'src/auth/guards/supply-organization.guard';
import { AuditAction } from 'src/event-log/audit-action.decorator';
import { CircuitTypeService } from './circuit-type.service';

@UseGuards(SupplyOrganizationGuard)
@Controller()
export class CircuitTypeController {
  constructor(private readonly service: CircuitTypeService) {}

  @TsRestHandler(contract.listCircuitTypes)
  async list() {
    return tsRestHandler(contract.listCircuitTypes, async ({ query }) => ({
      status: 200,
      body: await this.service.list(query.search),
    }));
  }

  @TsRestHandler(contract.getCircuitType)
  async getById() {
    return tsRestHandler(contract.getCircuitType, async ({ params }) => ({
      status: 200,
      body: await this.service.findById(params.id),
    }));
  }

  @AuditAction({ actionKey: 'circuit-type.created', resource: 'circuit-type', action: 'create' })
  @TsRestHandler(contract.createCircuitType)
  async create() {
    return tsRestHandler(contract.createCircuitType, async ({ body }) => ({
      status: 201,
      body: await this.service.create({
        name: body.name,
        slug: body.slug,
        color: body.color,
        description: body.description,
      }),
    }));
  }

  @AuditAction({ actionKey: 'circuit-type.updated', resource: 'circuit-type', action: 'update' })
  @TsRestHandler(contract.updateCircuitType)
  async update() {
    return tsRestHandler(contract.updateCircuitType, async ({ params, body }) => ({
      status: 200,
      body: await this.service.update(params.id, body),
    }));
  }

  @AuditAction({ actionKey: 'circuit-type.deleted', resource: 'circuit-type', action: 'delete' })
  @TsRestHandler(contract.deleteCircuitType)
  async delete() {
    return tsRestHandler(contract.deleteCircuitType, async ({ params }) => {
      await this.service.delete(params.id);
      return { status: 204 as const, body: undefined };
    });
  }
}
