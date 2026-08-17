import { Injectable } from '@nestjs/common';
import type { CollectorHandler, DeviceMutation } from '../collector.types';
import { type BmcInput, bmcSchema } from './bmc.schema';

@Injectable()
export class BmcHandler implements CollectorHandler<BmcInput> {
  readonly name = 'bmc' as const;
  readonly schema = bmcSchema;

  async handle(): Promise<DeviceMutation> {
    return {};
  }
}
