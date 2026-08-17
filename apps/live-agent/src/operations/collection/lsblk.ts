import { z } from 'zod';

import { registerOperation } from '../../dispatch/registry';
import { getErrorMessage } from '../../errors';
import { run } from '../../exec';

const LsblkDeviceSchema = z
  .object({
    name: z.string().optional(),
    type: z.string().optional(),
  })
  .passthrough();

const LsblkOutputSchema = z.object({
  blockdevices: z.array(LsblkDeviceSchema).optional(),
});

export function registerLsblkCollector(): void {
  registerOperation('collection.lsblk', async () => {
    const { stdout, exit_code, stderr } = await run(
      'lsblk',
      ['-d', '-o', 'NAME,SIZE,ROTA,SERIAL,WWN,MODEL,TYPE', '-J', '-b', '-e', '7,11,9,253'],
      { timeout_ms: 30_000 },
    );
    if (exit_code !== 0) {
      throw new Error(`lsblk failed (exit=${exit_code}): ${stderr.trim()}`);
    }

    let rawJson: unknown;
    try {
      rawJson = JSON.parse(stdout);
    } catch (error) {
      throw new Error(`lsblk emitted non-JSON output: ${getErrorMessage(error)}`);
    }
    const parsed = LsblkOutputSchema.parse(rawJson);

    const devices = (parsed.blockdevices ?? []).filter(
      (d) => !(d.name ?? '').startsWith('loop') && !(d.name ?? '').startsWith('sr'),
    );
    return { lsblk: devices };
  });
}
