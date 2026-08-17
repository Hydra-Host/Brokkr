import { Injectable } from '@nestjs/common';
import type { CollectorHandler, DeviceMutation } from '../collector.types';
import { type ArchitectureInput, architectureSchema } from './architecture.schema';

@Injectable()
export class ArchitectureHandler implements CollectorHandler<ArchitectureInput> {
  readonly name = 'architecture' as const;
  readonly schema = architectureSchema;

  async handle(input: ArchitectureInput): Promise<DeviceMutation> {
    return { deviceUpdate: { architecture: input.machine } };
  }
}
