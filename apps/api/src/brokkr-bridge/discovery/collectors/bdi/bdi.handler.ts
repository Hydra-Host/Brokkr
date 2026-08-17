import { Injectable } from '@nestjs/common';
import type { CollectorHandler, DeviceMutation } from '../collector.types';
import { type BdiInput, bdiSchema } from './bdi.schema';

@Injectable()
export class BdiHandler implements CollectorHandler<BdiInput> {
  readonly name = 'bdi' as const;
  readonly schema = bdiSchema;

  async handle(_input: BdiInput): Promise<DeviceMutation> {
    return {};
  }
}
