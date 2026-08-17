import { buildBaseCommand } from '../command.js';
import type { IPMIDevice } from '../device.js';
import type { IPMIResult } from '../result.js';
import { run } from '../transport.js';
import { IPMIValidationError } from '../validation.js';

const VALID_RESET_MODES: readonly string[] = ['cold', 'warm'];

export interface McOptions {
  timeout?: number;
}

export async function mcReset(device: IPMIDevice, mode = 'cold', opts: McOptions = {}): Promise<IPMIResult> {
  const timeout = opts.timeout ?? 30;
  if (!VALID_RESET_MODES.includes(mode)) {
    throw new IPMIValidationError(`Invalid mc reset mode: '${mode}' (must be 'cold' or 'warm')`);
  }
  const command = [...buildBaseCommand(device), 'mc', 'reset', mode];
  return run(command, device.password, timeout, { cipherUsed: device.cipher, jobId: device.jobId });
}

export async function mcInfo(device: IPMIDevice, opts: McOptions = {}): Promise<IPMIResult> {
  const timeout = opts.timeout ?? 30;
  const command = [...buildBaseCommand(device), 'mc', 'info'];
  return run(command, device.password, timeout, { cipherUsed: device.cipher, jobId: device.jobId });
}

export async function mcGetenables(device: IPMIDevice, opts: McOptions = {}): Promise<IPMIResult> {
  const timeout = opts.timeout ?? 30;
  const command = [...buildBaseCommand(device), 'mc', 'getenables'];
  return run(command, device.password, timeout, { cipherUsed: device.cipher, jobId: device.jobId });
}
