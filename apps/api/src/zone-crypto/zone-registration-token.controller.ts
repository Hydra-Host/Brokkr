import { Controller, UseGuards } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { InstanceOperatorGuard } from 'src/auth/guards/instance-operator.guard';
import { ZoneRegistrationTokenService } from './zone-registration-token.service';

@Controller()
@UseGuards(InstanceOperatorGuard)
export class ZoneRegistrationTokenController {
  constructor(private readonly tokenService: ZoneRegistrationTokenService) {}

  @TsRestHandler(contract.listZoneRegistrationTokens)
  async listZoneRegistrationTokens() {
    return tsRestHandler(contract.listZoneRegistrationTokens, async ({ params }) => {
      const result = await this.tokenService.listRegistrationTokens(params.zoneId);
      return { status: 200 as const, body: result };
    });
  }

  @TsRestHandler(contract.mintZoneRegistrationToken)
  async mintZoneRegistrationToken() {
    return tsRestHandler(contract.mintZoneRegistrationToken, async ({ params }) => {
      const result = await this.tokenService.mintRegistrationToken(params.zoneId);
      return { status: 201 as const, body: result };
    });
  }

  @TsRestHandler(contract.invalidateZoneRegistrationToken)
  async invalidateZoneRegistrationToken() {
    return tsRestHandler(contract.invalidateZoneRegistrationToken, async ({ params }) => {
      await this.tokenService.invalidateRegistrationToken(params.zoneId, params.tokenId);
      return { status: 204 as const, body: {} };
    });
  }
}
