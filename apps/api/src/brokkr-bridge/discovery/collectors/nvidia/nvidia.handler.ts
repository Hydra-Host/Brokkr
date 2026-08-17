import { Injectable } from '@nestjs/common';
import type { CollectorHandler, DeviceMutation, GpuUpsert } from '../collector.types';
import { type NvidiaInput, nvidiaSchema } from './nvidia.schema';

@Injectable()
export class NvidiaHandler implements CollectorHandler<NvidiaInput> {
  readonly name = 'nvidia' as const;
  readonly schema = nvidiaSchema;

  async handle(input: NvidiaInput): Promise<DeviceMutation> {
    if (!('gpus' in input)) {
      return { warnings: ['nvidia collector empty — preserving existing GPU rows'] };
    }

    const gpus: GpuUpsert[] = input.gpus.map((g) => ({
      index: g.index,
      model: g.name,
      vendor: 'NVIDIA',
      uuid: g.uuid,
      vbiosVersion: g.vbios ?? null,
      serial: g.serial ?? null,
      memoryTotalMb: g['memory.total'] ?? null,
    }));

    return { upserts: { gpus } };
  }
}
