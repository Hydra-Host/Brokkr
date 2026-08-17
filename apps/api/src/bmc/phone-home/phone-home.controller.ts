import { Controller, Req, UseGuards } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { Public } from 'src/auth/decorators/public.decorator';
import { Logger } from 'src/common/decorators/logger.decorator';
import { LoggerService } from 'src/logger/logger.service';
import type { PhoneHomeRequest } from './phone-home.guard';
import { PhoneHomeGuard } from './phone-home.guard';
import { PhoneHomeService } from './phone-home.service';

@Controller()
export class PhoneHomeController {
  constructor(
    private readonly phoneHomeService: PhoneHomeService,
    @Logger(PhoneHomeController.name) private readonly logger: LoggerService,
  ) {}

  @Public()
  @UseGuards(PhoneHomeGuard)
  @TsRestHandler(contract.createDeviceDiagnostics)
  async createDeviceDiagnostics(@Req() req: PhoneHomeRequest) {
    return tsRestHandler(contract.createDeviceDiagnostics, async ({ body }) => {
      const { deviceId } = req.phoneHome;
      this.logger.log(`Creating diagnostics for device ${deviceId}`);

      const result = await this.phoneHomeService.createDeviceDiagnostics(deviceId, body);

      return {
        status: 201 as const,
        body: {
          id: result.id,
          deploymentId: result.deploymentId,
          type: result.type,
          data: result.data,
        },
      };
    });
  }

  @Public()
  @UseGuards(PhoneHomeGuard)
  @TsRestHandler(contract.phoneHome)
  async phoneHome(@Req() req: PhoneHomeRequest) {
    return tsRestHandler(contract.phoneHome, async () => {
      return this.handlePhoneHome(req);
    });
  }

  @Public()
  @UseGuards(PhoneHomeGuard)
  @TsRestHandler(contract.phoneHomePost)
  async phoneHomePost(@Req() req: PhoneHomeRequest) {
    return tsRestHandler(contract.phoneHomePost, async () => {
      return this.handlePhoneHome(req);
    });
  }

  private async handlePhoneHome(req: PhoneHomeRequest) {
    const { deviceId } = req.phoneHome;
    this.logger.log(`Phone home received for device ${deviceId}`);

    await this.phoneHomeService.execute(deviceId);

    return {
      status: 200 as const,
      body: {
        message: `Phone home processed for device ${deviceId}`,
        deviceId,
      },
    };
  }
}
