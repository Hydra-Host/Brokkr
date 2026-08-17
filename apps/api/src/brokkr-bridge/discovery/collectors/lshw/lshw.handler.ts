import { Injectable } from '@nestjs/common';
import type { CollectorHandler, DeviceMutation } from '../collector.types';
import { type LshwInput, lshwSchema } from './lshw.schema';

@Injectable()
export class LshwHandler implements CollectorHandler<LshwInput> {
  readonly name = 'lshw' as const;
  readonly schema = lshwSchema;

  async handle(_input: LshwInput): Promise<DeviceMutation> {
    return {};
  }
}
