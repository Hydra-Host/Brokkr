import { Controller } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { DhcpLeasesService } from './dhcp-leases.service';

@Controller()
export class DhcpLeasesController {
  constructor(private readonly dhcpLeasesService: DhcpLeasesService) {}

  @TsRestHandler(contract.getZoneDhcpLeases)
  async getZoneDhcpLeases() {
    return tsRestHandler(contract.getZoneDhcpLeases, async ({ params }) => ({
      status: 200 as const,
      body: await this.dhcpLeasesService.getZoneDhcpLeases(params.zoneId),
    }));
  }

  @TsRestHandler(contract.revokeZoneDhcpLease)
  async revokeZoneDhcpLease() {
    return tsRestHandler(contract.revokeZoneDhcpLease, async ({ params }) => ({
      status: 200 as const,
      body: await this.dhcpLeasesService.revokeZoneDhcpLease(params.zoneId, params.ip),
    }));
  }
}
