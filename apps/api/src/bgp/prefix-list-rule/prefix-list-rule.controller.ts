import { Controller, UseGuards } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { SupplyOrganizationGuard } from 'src/auth/guards/supply-organization.guard';
import { PrefixListRuleService } from './prefix-list-rule.service';

@UseGuards(SupplyOrganizationGuard)
@Controller()
export class PrefixListRuleController {
  constructor(private readonly service: PrefixListRuleService) {}

  @TsRestHandler(contract.listPrefixListRules)
  async list() {
    return tsRestHandler(contract.listPrefixListRules, async ({ query }) => ({
      status: 200,
      body: await this.service.list({ prefixListId: query.prefixListId, search: query.search }),
    }));
  }

  @TsRestHandler(contract.getPrefixListRule)
  async getById() {
    return tsRestHandler(contract.getPrefixListRule, async ({ params }) => ({
      status: 200,
      body: await this.service.findById(params.id),
    }));
  }

  @TsRestHandler(contract.createPrefixListRule)
  async create() {
    return tsRestHandler(contract.createPrefixListRule, async ({ body }) => ({
      status: 201,
      body: await this.service.create({
        action: body.action,
        prefix: body.prefix,
        ge: body.ge,
        le: body.le,
        sequence: body.sequence,
        prefixListId: body.prefixListId,
      }),
    }));
  }

  @TsRestHandler(contract.updatePrefixListRule)
  async update() {
    return tsRestHandler(contract.updatePrefixListRule, async ({ params, body }) => ({
      status: 200,
      body: await this.service.update(params.id, body),
    }));
  }

  @TsRestHandler(contract.deletePrefixListRule)
  async delete() {
    return tsRestHandler(contract.deletePrefixListRule, async ({ params }) => {
      await this.service.delete(params.id);
      return { status: 204 as const, body: undefined };
    });
  }
}
