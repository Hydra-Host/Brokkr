import { Controller, Ip, UseGuards } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { Public } from 'src/auth/decorators/public.decorator';

import { ZoneRegistrationTokenGuard } from './guards/zone-registration-token.guard';
import { ZoneCryptoService } from './zone-crypto.service';

@Controller()
export class ZoneCryptoController {
  constructor(private readonly zoneCryptoService: ZoneCryptoService) {}

  @Public()
  @UseGuards(ZoneRegistrationTokenGuard)
  @TsRestHandler(contract.enrollZone)
  async enrollZone(@Ip() ip: string) {
    return tsRestHandler(contract.enrollZone, async ({ params, body }) => {
      const result = await this.zoneCryptoService.enrollZone(params.zoneId, body, { ip });
      return { status: 200 as const, body: result };
    });
  }
}
