import { Controller, UseGuards } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { SupplyOrganizationGuard } from 'src/auth/guards/supply-organization.guard';
import { ConnectionService } from './connection.service';

@UseGuards(SupplyOrganizationGuard)
@Controller()
export class ConnectionController {
  constructor(private readonly service: ConnectionService) {}

  @TsRestHandler(contract.listDcimInterfaceConnections)
  async listInterfaceConnections() {
    return tsRestHandler(contract.listDcimInterfaceConnections, async ({ query }) => ({
      status: 200,
      body: await this.service.listInterfaceConnections(query),
    }));
  }

  @TsRestHandler(contract.listDcimConsoleConnections)
  async listConsoleConnections() {
    return tsRestHandler(contract.listDcimConsoleConnections, async ({ query }) => ({
      status: 200,
      body: await this.service.listConsoleConnections(query),
    }));
  }

  @TsRestHandler(contract.listDcimPowerConnections)
  async listPowerConnections() {
    return tsRestHandler(contract.listDcimPowerConnections, async ({ query }) => ({
      status: 200,
      body: await this.service.listPowerConnections(query),
    }));
  }
}
