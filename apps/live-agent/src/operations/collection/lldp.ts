import { z } from 'zod';

import { registerOperation } from '../../dispatch/registry';
import { getErrorMessage } from '../../errors';
import { CommandAborted, run } from '../../exec';

const LldpRawSchema = z.record(z.unknown());

export function registerLldpCollector(): void {
  registerOperation('collection.lldp', async () => {
    try {
      const { stdout, exit_code, stderr } = await run('lldpctl', ['-f', 'json'], {
        timeout_ms: 15_000,
      });
      if (exit_code !== 0) {
        throw new Error(`lldpctl failed (exit=${exit_code}): ${stderr.trim()}`);
      }
      const trimmed = stdout.trim();
      if (trimmed === '') {
        return { lldp: { status: 'no_data' } };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch (error) {
        throw new Error(`lldpctl emitted non-JSON output: ${getErrorMessage(error)}`);
      }
      return { lldp: LldpRawSchema.parse(parsed) };
    } catch (error) {
      if (error instanceof CommandAborted) throw error;
      return { lldp: { status: 'error', error: getErrorMessage(error) } };
    }
  });
}
