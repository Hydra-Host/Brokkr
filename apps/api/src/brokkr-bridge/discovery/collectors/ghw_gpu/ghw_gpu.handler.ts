import { Injectable } from '@nestjs/common';
import type { CollectorHandler, DeviceMutation } from '../collector.types';
import { type GhwGpuInput, ghwGpuSchema } from './ghw_gpu.schema';

@Injectable()
export class GhwGpuHandler implements CollectorHandler<GhwGpuInput> {
  readonly name = 'ghw_gpu' as const;
  readonly schema = ghwGpuSchema;

  async handle(_input: GhwGpuInput): Promise<DeviceMutation> {
    return {};
  }
}
