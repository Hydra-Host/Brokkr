import { Injectable } from '@nestjs/common';
import type { CollectorHandler, DeviceMutation } from '../collector.types';
import { type FirmwareTypeInput, firmwareTypeSchema } from './firmware_type.schema';

@Injectable()
export class FirmwareTypeHandler implements CollectorHandler<FirmwareTypeInput> {
  readonly name = 'firmware_type' as const;
  readonly schema = firmwareTypeSchema;

  async handle(input: FirmwareTypeInput): Promise<DeviceMutation> {
    const value = input.toLowerCase();
    if (value !== 'efi' && value !== 'bios') {
      return { warnings: [`unexpected firmware_type: ${JSON.stringify(input)}`] };
    }
    return {};
  }
}
