import { Controller } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { DeviceTokenContext } from '@repo/database';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { Public } from 'src/auth/decorators/public.decorator';
import { DeviceTokenAppService } from './device-token-app.service';
import { DeviceTokenAuth } from './device-token-auth.decorator';

@Controller()
export class DeviceTokensController {
  constructor(private readonly deviceTokenAppService: DeviceTokenAppService) {}

  @Public()
  @DeviceTokenAuth(DeviceTokenContext.BROKKR_LIVE)
  @TsRestHandler(contract.rotateBrokkrLiveDeviceToken)
  rotateBrokkrLiveDeviceToken() {
    return tsRestHandler(contract.rotateBrokkrLiveDeviceToken, async () => {
      const body = await this.deviceTokenAppService.rotateBrokkrLiveTokenForCaller();
      return { status: 200 as const, body };
    });
  }
}
