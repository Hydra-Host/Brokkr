import { z } from 'zod';

import { registerOperation } from '../../dispatch/registry';
import { getErrorMessage } from '../../errors';
import { run } from '../../exec';

const EfiBootOptionSchema = z
  .object({
    boot_option_reference: z.string().optional(),
    display_name: z.string().optional(),
    uefi_device_path: z.string().optional(),
    boot_option_enabled: z.boolean().optional(),
  })
  .passthrough();

const EfibootmgrSchema = z
  .object({
    boot_current: z.string().optional(),
    boot_next: z.string().optional(),
    timeout_seconds: z.number().optional(),
    boot_order: z.array(z.string()).optional(),
    boot_options: z.array(EfiBootOptionSchema).optional(),
    mirror_memory_below_4gb: z.boolean().optional(),
    mirrored_percentage_above_4g: z.number().optional(),
  })
  .passthrough();

export function registerEfibootmgrCollector(): void {
  registerOperation('collection.efibootmgr', async () => {
    const eb = await run('efibootmgr', ['-v'], { timeout_ms: 15_000 });
    if (eb.exit_code !== 0) {
      throw new Error(`efibootmgr -v failed (exit=${eb.exit_code}): ${eb.stderr.trim()}`);
    }
    const jcRes = await run('jc', ['--efibootmgr'], {
      stdin: eb.stdout,
      timeout_ms: 15_000,
    });
    if (jcRes.exit_code !== 0) {
      throw new Error(`jc --efibootmgr failed (exit=${jcRes.exit_code}): ${jcRes.stderr.trim()}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(jcRes.stdout);
    } catch (error) {
      throw new Error(`jc --efibootmgr emitted non-JSON output: ${getErrorMessage(error)}`);
    }
    return { efibootmgr: EfibootmgrSchema.parse(parsed) };
  });
}
