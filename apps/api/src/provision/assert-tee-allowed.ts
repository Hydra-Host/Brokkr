import { BadRequestException } from '@nestjs/common';
import { ServerSpecHelper, type ServerSpecsInput } from '@repo/device-domain';
import { LAYER_SLUGS } from '@repo/layers';
import { platformVariant } from 'src/brokkr-bridge/lifecycle/platform-slug';

export function isTeeRequested(
  operatingSystem: string,
  tee: boolean | undefined,
  customizations?: string[] | null,
): boolean {
  return (
    Boolean(tee) ||
    platformVariant(operatingSystem) === 'tee' ||
    (customizations ?? []).includes(LAYER_SLUGS.tee.TEE_SETUP)
  );
}

export function assertTeeAllowed(device: ServerSpecsInput): void {
  if (!ServerSpecHelper.teeCapable(device)) {
    throw new BadRequestException('TEE is not supported on this device');
  }
}
