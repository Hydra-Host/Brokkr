import { z } from 'zod';

import { registerOperation } from '../../dispatch/registry';
import { getErrorMessage } from '../../errors';
import { run } from '../../exec';

const ExtendedCpuEntry = z.object({
  online: z.string().optional(),
  socket: z.union([z.number(), z.string()]).optional(),
  core: z.union([z.number(), z.string()]).optional(),
});

const ExtendedLscpuOutput = z.object({
  cpus: z.array(ExtendedCpuEntry).optional(),
});

const GeneralCpuEntry = z.object({
  field: z.string().optional(),
  data: z.string().optional(),
});

const GeneralLscpuOutput = z.object({
  lscpu: z.array(GeneralCpuEntry).optional(),
});

export function registerLscpuCollector(): void {
  registerOperation('collection.lscpu', async () => {
    const ext = await run('lscpu', ['--extended', '--json'], { timeout_ms: 15_000 });
    if (ext.exit_code !== 0) {
      throw new Error(`lscpu --extended --json failed (exit=${ext.exit_code}): ${ext.stderr.trim()}`);
    }

    let extRaw: unknown;
    try {
      extRaw = JSON.parse(ext.stdout);
    } catch (error) {
      throw new Error(`lscpu --extended --json emitted non-JSON: ${getErrorMessage(error)}`);
    }
    const extData = ExtendedLscpuOutput.parse(extRaw);
    const cpus = extData.cpus ?? [];

    const sockets = new Set<number | string>();
    const coreKeys = new Set<string>();
    let totalThreads = 0;

    for (const cpu of cpus) {
      if (cpu.online === 'no') continue;
      if (cpu.socket !== undefined) sockets.add(cpu.socket);
      if (cpu.socket !== undefined && cpu.core !== undefined) {
        coreKeys.add(`${cpu.socket}:${cpu.core}`);
      }
      totalThreads += 1;
    }

    const totalSockets = sockets.size || 1;
    const totalCores = coreKeys.size || totalThreads;

    const gen = await run('lscpu', ['--json'], { timeout_ms: 15_000 });
    if (gen.exit_code !== 0) {
      throw new Error(`lscpu --json failed (exit=${gen.exit_code}): ${gen.stderr.trim()}`);
    }

    let genRaw: unknown;
    try {
      genRaw = JSON.parse(gen.stdout);
    } catch (error) {
      throw new Error(`lscpu --json emitted non-JSON: ${getErrorMessage(error)}`);
    }
    const genData = GeneralLscpuOutput.parse(genRaw);

    let cpu_family: string | null = null;
    let cpu_model: string | null = null;
    for (const entry of genData.lscpu ?? []) {
      const field = entry.field ?? '';
      if (field.startsWith('CPU family:')) cpu_family = entry.data ?? null;
      else if (field.startsWith('Model:')) cpu_model = entry.data ?? null;
    }

    return {
      lscpu: {
        total_cpu_sockets: totalSockets,
        total_cpu_cores: totalCores,
        total_cpu_threads: totalThreads,
        per_cpu_cores: Math.floor(totalCores / totalSockets),
        per_cpu_threads: Math.floor(totalThreads / totalSockets),
        cpu_family,
        cpu_model,
      },
    };
  });
}
