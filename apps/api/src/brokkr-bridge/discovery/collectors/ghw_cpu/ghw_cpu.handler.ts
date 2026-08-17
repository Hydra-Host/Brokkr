import { Injectable } from '@nestjs/common';
import { architectureSchema } from '../architecture/architecture.schema';
import type {
  CollectorContext,
  CollectorHandler,
  CpuUpsert,
  DeviceMutation,
  RawCollectorBundle,
} from '../collector.types';
import { type GhwCpuInput, ghwCpuSchema } from './ghw_cpu.schema';

@Injectable()
export class GhwCpuHandler implements CollectorHandler<GhwCpuInput> {
  readonly name = 'ghw_cpu' as const;
  readonly schema = ghwCpuSchema;

  async handle(input: GhwCpuInput, ctx?: CollectorContext): Promise<DeviceMutation> {
    if (!input.cpu.processors[0]?.model) return {};

    const architecture = ctx ? parseArchitectureFromRawBundle(ctx.rawBundle) : null;

    const cpus: CpuUpsert[] = [];
    for (const p of input.cpu.processors) {
      if (!p.model) continue;
      const upsert: CpuUpsert = {
        socketIndex: p.id,
        model: p.model,
        coreCount: p.total_cores ?? null,
        threadCount: p.total_threads ?? null,
        capabilities: p.capabilities ?? [],
      };
      if (p.vendor != null) upsert.vendor = p.vendor;
      if (architecture != null) upsert.architecture = architecture;
      cpus.push(upsert);
    }

    return { upserts: { cpus } };
  }
}

function parseArchitectureFromRawBundle(rawBundle: RawCollectorBundle): string | null {
  if (rawBundle.architecture === undefined) return null;
  const parsed = architectureSchema.safeParse(rawBundle.architecture);
  return parsed.success ? parsed.data.machine : null;
}
