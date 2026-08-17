import { SetMetadata, UseGuards, applyDecorators } from '@nestjs/common';
import { DeviceTokenContext } from '@repo/database';
import { DEVICE_TOKEN_CONTEXTS_KEY } from './device-token.constants';
import { DeviceTokenGuard } from './device-token.guard';

export function DeviceTokenAuth(...contexts: DeviceTokenContext[]) {
  return applyDecorators(SetMetadata(DEVICE_TOKEN_CONTEXTS_KEY, contexts), UseGuards(DeviceTokenGuard));
}
