import { Injectable } from '@nestjs/common';
import type { CollectorHandler, DeviceMutation } from '../collector.types';
import { type GhwMemoryInput, ghwMemorySchema } from './ghw_memory.schema';

@Injectable()
export class GhwMemoryHandler implements CollectorHandler<GhwMemoryInput> {
  readonly name = 'ghw_memory' as const;
  readonly schema = ghwMemorySchema;

  async handle(): Promise<DeviceMutation> {
    return {};
  }
}
