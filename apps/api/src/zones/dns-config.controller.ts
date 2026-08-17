import { Controller } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { DnsConfigService } from './dns-config.service';

@Controller()
export class DnsConfigController {
  constructor(private readonly dnsConfigService: DnsConfigService) {}

  @TsRestHandler(contract.getZoneDnsConfig)
  async getZoneDnsConfig() {
    return tsRestHandler(contract.getZoneDnsConfig, async ({ params }) => {
      const config = await this.dnsConfigService.getZoneDnsConfig(params.zoneId);
      return { status: 200 as const, body: config };
    });
  }

  @TsRestHandler(contract.updateZoneDnsConfig)
  async updateZoneDnsConfig() {
    return tsRestHandler(contract.updateZoneDnsConfig, async ({ params, body }) => {
      const config = await this.dnsConfigService.updateZoneDnsConfig(params.zoneId, body);
      return { status: 200 as const, body: config };
    });
  }
}
