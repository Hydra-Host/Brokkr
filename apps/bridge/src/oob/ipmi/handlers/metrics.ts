import { buildBaseCommand, withCsvFlag } from '../command.js';
import type { IPMIDevice } from '../device.js';
import { getIpmiMonitoringConfig } from '../ipmi.config.js';
import type { IPMIResult } from '../result.js';
import { run } from '../transport.js';
import { validateIpmiCommand } from '../validation.js';

export interface MetricsCommandOptions {
  timeout?: number | null;
}

export function splitCommandString(command: string): string[] {
  const trimmed = command.trim();
  return trimmed === '' ? [] : trimmed.split(/\s+/);
}

export async function executeMetricsCommand(
  device: IPMIDevice,
  commandParts: string | readonly string[],
  opts: MetricsCommandOptions = {},
): Promise<IPMIResult> {
  const cfg = getIpmiMonitoringConfig();

  const parts = typeof commandParts === 'string' ? splitCommandString(commandParts) : commandParts.map(String);

  const validated = validateIpmiCommand(parts);

  let base = buildBaseCommand(device);
  const head = validated[0];
  if (head !== undefined && cfg.csvOutputCommands.includes(head)) {
    base = withCsvFlag(base);
  }

  const finalCommand = [...base, ...validated];
  const effectiveTimeout = opts.timeout ?? cfg.commandTimeoutSeconds;

  return run(finalCommand, device.password, effectiveTimeout, { cipherUsed: device.cipher, jobId: device.jobId });
}
