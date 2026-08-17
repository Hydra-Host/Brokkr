import { Injectable } from '@nestjs/common';
import type { CollectorHandler, DeviceMutation } from '../collector.types';
import { type GhwBaseboardInput, ghwBaseboardSchema } from './ghw_baseboard.schema';

@Injectable()
export class GhwBaseboardHandler implements CollectorHandler<GhwBaseboardInput> {
  readonly name = 'ghw_baseboard' as const;
  readonly schema = ghwBaseboardSchema;

  async handle(input: GhwBaseboardInput): Promise<DeviceMutation> {
    return {
      deviceUpdate: { baseboardSerial: input.baseboard.serial_number },
    };
  }
}
