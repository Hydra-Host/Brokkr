import { z } from 'zod';

import { registerOperation } from '../../dispatch/registry';
import { getErrorMessage } from '../../errors';
import { run } from '../../exec';

const LshwNodeSchema: z.ZodType<unknown> = z.lazy(() =>
  z
    .object({
      id: z.string().optional(),
      class: z.string().optional(),
      claimed: z.boolean().optional(),
      handle: z.string().optional(),
      description: z.string().optional(),
      product: z.string().optional(),
      vendor: z.string().optional(),
      serial: z.string().optional(),
      physid: z.string().optional(),
      businfo: z.string().optional(),
      logicalname: z.union([z.string(), z.array(z.string())]).optional(),
      dev: z.string().optional(),
      version: z.string().optional(),
      width: z.number().optional(),
      clock: z.number().optional(),
      size: z.number().optional(),
      capacity: z.number().optional(),
      slot: z.string().optional(),
      units: z.string().optional(),
      configuration: z.record(z.unknown()).optional(),
      capabilities: z.record(z.unknown()).optional(),
      children: z.array(LshwNodeSchema).optional(),
    })
    .passthrough(),
);

export function registerLshwCollector(): void {
  registerOperation('collection.lshw', async () => {
    const { stdout, exit_code, stderr } = await run('lshw', ['-json'], {
      timeout_ms: 60_000,
    });
    if (exit_code !== 0) {
      throw new Error(`lshw -json failed (exit=${exit_code}): ${stderr.trim()}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch (error) {
      throw new Error(`lshw -json emitted non-JSON output: ${getErrorMessage(error)}`);
    }
    const rootSchema = z.union([LshwNodeSchema, z.array(LshwNodeSchema)]);
    return { lshw: rootSchema.parse(parsed) };
  });
}
