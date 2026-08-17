import { Injectable } from '@nestjs/common';
import type { CollectorHandler, DeviceMutation } from '../collector.types';
import { type GhwChassisInput, ghwChassisSchema } from './ghw_chassis.schema';

@Injectable()
export class GhwChassisHandler implements CollectorHandler<GhwChassisInput> {
  readonly name = 'ghw_chassis' as const;
  readonly schema = ghwChassisSchema;

  async handle(input: GhwChassisInput): Promise<DeviceMutation> {
    return {
      deviceUpdate: {
        chassisSerial: input.chassis.serial_number,
        assetTag: input.chassis.asset_tag,
      },
    };
  }
}
