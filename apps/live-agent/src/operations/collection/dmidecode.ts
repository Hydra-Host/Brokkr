import { z } from 'zod';

import { registerOperation } from '../../dispatch/registry';
import { getErrorMessage } from '../../errors';
import { run } from '../../exec';
import { makeLogger } from '../../logger';

const logger = makeLogger('collection');

const DmidecodeRecordSchema = z
  .object({
    handle: z.string().optional(),
    type: z.number().optional(),
    bytes: z.number().optional(),
    description: z.string().optional(),
    values: z.record(z.unknown()).nullable().optional(),
  })
  .passthrough();

const DmidecodeSchema = z.array(DmidecodeRecordSchema);

export function validateDmidecode(parsed: unknown): unknown {
  const check = DmidecodeSchema.safeParse(parsed);
  if (check.success) return check.data;
  logger.warn('jc --dmidecode output failed schema validation; delivering raw payload', {
    issues: check.error.issues.slice(0, 5),
  });
  return parsed;
}

export function registerDmidecodeCollector(): void {
  registerOperation('collection.dmidecode', async () => {
    const dmi = await run('dmidecode', [], { timeout_ms: 30_000 });
    if (dmi.exit_code !== 0) {
      throw new Error(`dmidecode failed (exit=${dmi.exit_code}): ${dmi.stderr.trim()}`);
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
    return { dmidecode: validateDmidecode(parsed) };
  });
}
