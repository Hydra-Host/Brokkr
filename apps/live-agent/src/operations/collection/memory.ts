import { z } from 'zod';

import { registerOperation } from '../../dispatch/registry';
import { getErrorMessage } from '../../errors';
import { run } from '../../exec';
import { makeLogger } from '../../logger';

const logger = makeLogger('collection');

const MemoryRecordSchema = z
  .object({
    handle: z.string().optional(),
    type: z.number().optional(),
    bytes: z.number().optional(),
    description: z.string().optional(),
    values: z.record(z.unknown()).nullable().optional(),
  })
  .passthrough();

const DmidecodeMemorySchema = z.array(MemoryRecordSchema);

export function validateDmidecodeMemory(parsed: unknown): unknown {
  const check = DmidecodeMemorySchema.safeParse(parsed);
  if (check.success) return check.data;
  logger.warn('jc --dmidecode (memory) output failed schema validation; delivering raw payload', {
    issues: check.error.issues.slice(0, 5),
  });
  return parsed;
}

export function registerMemoryCollector(): void {
  registerOperation('collection.memory', async () => {
    const dmi = await run('dmidecode', ['-t', 'memory'], { timeout_ms: 30_000 });
    if (dmi.exit_code !== 0) {
      throw new Error(`dmidecode -t memory failed (exit=${dmi.exit_code}): ${dmi.stderr.trim()}`);
    }
    const jcRes = await run('jc', ['--dmidecode'], {
      stdin: dmi.stdout,
      timeout_ms: 30_000,
    });
    if (jcRes.exit_code !== 0) {
      throw new Error(`jc --dmidecode failed (exit=${jcRes.exit_code}): ${jcRes.stderr.trim()}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(jcRes.stdout);
    } catch (error) {
      throw new Error(`jc --dmidecode emitted non-JSON output: ${getErrorMessage(error)}`);
    }
    return { dmidecode_memory: validateDmidecodeMemory(parsed) };
  });
}
