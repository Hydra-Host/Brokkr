import { Controller, UseGuards } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { SupplyOrganizationGuard } from 'src/auth/guards/supply-organization.guard';
import { AuditAction } from 'src/event-log/audit-action.decorator';
import { RackRoleService } from './rack-role.service';

@UseGuards(SupplyOrganizationGuard)
@Controller()
export class RackRoleController {
  constructor(private readonly service: RackRoleService) {}

  @TsRestHandler(contract.listDcimRackRoles)
  async list() {
    return tsRestHandler(contract.listDcimRackRoles, async ({ query }) => ({
      status: 200,
      body: await this.service.list(query.search),
    }));
  }

  @TsRestHandler(contract.getDcimRackRole)
  async getById() {
    return tsRestHandler(contract.getDcimRackRole, async ({ params }) => ({
      status: 200,
      body: await this.service.findById(params.id),
    }));
  }

  @AuditAction({ actionKey: 'rack-role.created', resource: 'rack-role', action: 'create' })
  @TsRestHandler(contract.createDcimRackRole)
  async create() {
    return tsRestHandler(contract.createDcimRackRole, async ({ body }) => ({
      status: 201,
      body: await this.service.create({
        name: body.name,
        slug: body.slug,
        color: body.color,
        description: body.description,
      }),
    }));
  }

  @AuditAction({ actionKey: 'rack-role.updated', resource: 'rack-role', action: 'update' })
  @TsRestHandler(contract.updateDcimRackRole)
  async update() {
    return tsRestHandler(contract.updateDcimRackRole, async ({ params, body }) => ({
      status: 200,
      body: await this.service.update(params.id, body),
    }));
  }

  @AuditAction({ actionKey: 'rack-role.deleted', resource: 'rack-role', action: 'delete' })
  @TsRestHandler(contract.deleteDcimRackRole)
  async delete() {
    return tsRestHandler(contract.deleteDcimRackRole, async ({ params }) => {
      await this.service.delete(params.id);
      return { status: 204 as const, body: undefined };
    });
  }
}
