import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DeviceTokenContext } from '@repo/database';
import type { Request } from 'express';
import { ContextService } from 'src/common/context/context.service';
import { extractBearerToken, readHeaderValue } from './bearer-token.utils';
import { DEVICE_TOKEN_CONTEXTS_KEY } from './device-token.constants';
import { DeviceTokensService } from './device-tokens.service';

@Injectable()
export class DeviceTokenGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly contextService: ContextService,
    private readonly deviceTokensService: DeviceTokensService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = extractBearerToken(request.headers.authorization);

    const allowedContexts = this.reflector.getAllAndOverride<DeviceTokenContext[]>(DEVICE_TOKEN_CONTEXTS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]) ?? [DeviceTokenContext.BROKKR_LIVE, DeviceTokenContext.DEPLOYMENT_OS];

    const deviceIdentity = await this.deviceTokensService.verifyPlaintextToken({
      plaintext: token,
      allowedContexts,
      ip: request.ip,
      userAgent: readHeaderValue(request.headers['user-agent']),
    });

    this.contextService.deviceIdentity = deviceIdentity;
    return true;
  }
}
