import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { DeviceTokenContext } from '@repo/database';
import type { Request } from 'express';
import { ContextService } from 'src/common/context/context.service';
import { extractBearerToken, readHeaderValue } from 'src/device-tokens/bearer-token.utils';
import { DeviceTokensService } from 'src/device-tokens/device-tokens.service';

export interface PhoneHomeRequest extends Request {
  phoneHome: {
    deviceId: string;
  };
}

@Injectable()
export class PhoneHomeGuard implements CanActivate {
  constructor(
    private readonly deviceTokensService: DeviceTokensService,
    private readonly contextService: ContextService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<PhoneHomeRequest>();

    const bearerToken = extractBearerToken(request.headers?.authorization);

    const deviceIdentity = await this.deviceTokensService.verifyPlaintextToken({
      plaintext: bearerToken,
      allowedContexts: [DeviceTokenContext.BROKKR_LIVE, DeviceTokenContext.DEPLOYMENT_OS],
      ip: request.ip,
      userAgent: readHeaderValue(request.headers?.['user-agent']),
    });
    this.contextService.deviceIdentity = deviceIdentity;

    request.phoneHome = {
      deviceId: deviceIdentity.deviceId,
    };

    return true;
  }
}
