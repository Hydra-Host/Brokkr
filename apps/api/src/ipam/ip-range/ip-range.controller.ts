import { Controller, UseGuards } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { SupplyOrganizationGuard } from 'src/auth/guards/supply-organization.guard';
import { IpRangeService } from './ip-range.service';

@UseGuards(SupplyOrganizationGuard)
@Controller()
export class IpRangeController {
  constructor(private readonly iprangeService: IpRangeService) {}

  @TsRestHandler(contract.getIpRange)
  async getById() {
    return tsRestHandler(contract.getIpRange, async ({ params }) => ({
      status: 200 as const,
      body: await this.iprangeService.findById(params.id),
    }));
  }

  @TsRestHandler(contract.listIpRanges)
  async listIpRanges() {
    return tsRestHandler(contract.listIpRanges, async ({ query }) => ({
      status: 200,
      body: await this.iprangeService.listIpRanges(query),
    }));
  }

  @TsRestHandler(contract.createIpRange)
  async createIpRange() {
    return tsRestHandler(contract.createIpRange, async ({ body }) => ({
      status: 201,
      body: await this.iprangeService.createIpRange(body),
    }));
  }

  @TsRestHandler(contract.updateIpRange)
  async updateIpRange() {
    return tsRestHandler(contract.updateIpRange, async ({ params, body }) => ({
      status: 200,
      body: await this.iprangeService.updateIpRange(params.id, body),
    }));
  }

  @TsRestHandler(contract.archiveIpRange)
  async archiveIpRange() {
    return tsRestHandler(contract.archiveIpRange, async ({ params }) => ({
      status: 200,
      body: await this.iprangeService.archiveIpRange(params.id),
    }));
  }

  @TsRestHandler(contract.detectIpRangeOverlap)
  async detectIpRangeOverlap() {
    return tsRestHandler(contract.detectIpRangeOverlap, async ({ body }) => ({
      status: 200,
      body: await this.iprangeService.detectIpRangeOverlap(body),
    }));
  }
}
