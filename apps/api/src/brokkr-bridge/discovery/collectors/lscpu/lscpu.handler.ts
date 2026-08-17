import { Injectable } from '@nestjs/common';
import type { CollectorHandler, DeviceMutation } from '../collector.types';
import { type LscpuInput, lscpuSchema } from './lscpu.schema';

@Injectable()
export class LscpuHandler implements CollectorHandler<LscpuInput> {
  readonly name = 'lscpu' as const;
  readonly schema = lscpuSchema;

  async handle(): Promise<DeviceMutation> {
    return {};
  }
}
