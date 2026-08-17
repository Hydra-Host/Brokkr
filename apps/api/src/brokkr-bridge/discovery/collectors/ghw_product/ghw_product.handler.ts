import { Injectable } from '@nestjs/common';
import type { CollectorHandler, DeviceMutation } from '../collector.types';
import { type GhwProductInput, ghwProductSchema } from './ghw_product.schema';

@Injectable()
export class GhwProductHandler implements CollectorHandler<GhwProductInput> {
  readonly name = 'ghw_product' as const;
  readonly schema = ghwProductSchema;

  async handle(input: GhwProductInput): Promise<DeviceMutation> {
    const deviceUpdate: Record<string, string | null> = {
      systemUuid: input.product.uuid ?? null,
      serial: input.product.serial_number,
      productSku: input.product.sku,
    };
    return { deviceUpdate };
  }
}
