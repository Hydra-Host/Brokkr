import { Controller, UseGuards } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { SupplyOrganizationGuard } from 'src/auth/guards/supply-organization.guard';
import { IpAddressService } from './ip-address.service';

@UseGuards(SupplyOrganizationGuard)
@Controller()
export class IpAddressController {
  constructor(private readonly ipaddressService: IpAddressService) {}

  @TsRestHandler(contract.getIpAddress)
  async getById() {
    return tsRestHandler(contract.getIpAddress, async ({ params }) => ({
      status: 200 as const,
      body: await this.ipaddressService.findById(params.id),
    }));
  }

  @TsRestHandler(contract.listIpAddresses)
  async listIpAddresses() {
    return tsRestHandler(contract.listIpAddresses, async ({ query }) => ({
      status: 200,
      body: await this.ipaddressService.listIpAddresses(query),
    }));
  }

  @TsRestHandler(contract.createIpAddress)
  async createIpAddress() {
    return tsRestHandler(contract.createIpAddress, async ({ body }) => ({
      status: 201,
      body: await this.ipaddressService.createIpAddress(body),
    }));
  }

  @TsRestHandler(contract.updateIpAddress)
  async updateIpAddress() {
    return tsRestHandler(contract.updateIpAddress, async ({ params, body }) => ({
      status: 200,
      body: await this.ipaddressService.updateIpAddress(params.id, body),
    }));
  }

  @TsRestHandler(contract.archiveIpAddress)
  async archiveIpAddress() {
    return tsRestHandler(contract.archiveIpAddress, async ({ params }) => ({
      status: 200,
      body: await this.ipaddressService.archiveIpAddress(params.id),
    }));
  }
}
