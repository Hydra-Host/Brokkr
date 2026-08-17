import { Injectable } from '@nestjs/common';
import type { CollectorHandler, DeviceMutation } from '../collector.types';
import { type EfiInput, efiSchema } from './efi.schema';

@Injectable()
export class EfiHandler implements CollectorHandler<EfiInput> {
  readonly name = 'efi' as const;
  readonly schema = efiSchema;

  async handle(_input: EfiInput): Promise<DeviceMutation> {
    return {};
  }
}
