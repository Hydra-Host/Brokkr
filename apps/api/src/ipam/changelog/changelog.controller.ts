import { Controller, UseGuards } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { SupplyOrganizationGuard } from 'src/auth/guards/supply-organization.guard';
import { IpamChangelogService } from './changelog.service';

@UseGuards(SupplyOrganizationGuard)
@Controller()
export class IpamChangelogController {
  constructor(private readonly changelogService: IpamChangelogService) {}

  @TsRestHandler(contract.listIpamChangelog)
  async listIpamChangelog() {
    return tsRestHandler(contract.listIpamChangelog, async ({ query }) => ({
      status: 200,
      body: await this.changelogService.listIpamChangelog(query),
    }));
  }
}
