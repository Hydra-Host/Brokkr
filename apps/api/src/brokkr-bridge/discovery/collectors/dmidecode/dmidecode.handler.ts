import { Injectable } from '@nestjs/common';
import type { CollectorHandler, DeviceMutation } from '../collector.types';
import { type DmidecodeInput, dmidecodeSchema } from './dmidecode.schema';

@Injectable()
export class DmidecodeHandler implements CollectorHandler<DmidecodeInput> {
  readonly name = 'dmidecode' as const;
  readonly schema = dmidecodeSchema;

  async handle(_input: DmidecodeInput): Promise<DeviceMutation> {
    return {};
  }
}
