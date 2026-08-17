import { Injectable } from '@nestjs/common';
import type { CollectorHandler, DeviceMutation } from '../collector.types';
import { type GhwBiosInput, ghwBiosSchema } from './ghw_bios.schema';

@Injectable()
export class GhwBiosHandler implements CollectorHandler<GhwBiosInput> {
  readonly name = 'ghw_bios' as const;
  readonly schema = ghwBiosSchema;

  async handle(input: GhwBiosInput): Promise<DeviceMutation> {
    return {
      upserts: {
        firmwares: [
          {
            type: 'BIOS',
            vendor: input.bios.vendor,
            version: input.bios.version,
            date: input.bios.date,
          },
        ],
      },
    };
  }
}
