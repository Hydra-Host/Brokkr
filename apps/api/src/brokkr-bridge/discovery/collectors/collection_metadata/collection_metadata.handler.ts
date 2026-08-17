import { Injectable } from '@nestjs/common';
import type { CollectorHandler, DeviceMutation } from '../collector.types';
import { type CollectionMetadataInput, collectionMetadataSchema } from './collection_metadata.schema';

@Injectable()
export class CollectionMetadataHandler implements CollectorHandler<CollectionMetadataInput> {
  readonly name = 'collection_metadata' as const;
  readonly schema = collectionMetadataSchema;

  async handle(input: CollectionMetadataInput): Promise<DeviceMutation> {
    const warnings: string[] = [];
    if (input.collectors_successful < input.collectors_total) {
      warnings.push(
        `bridge-side partial success: ${input.collectors_successful}/${input.collectors_total} collectors ok`,
      );
    }
    return warnings.length ? { warnings } : {};
  }
}
