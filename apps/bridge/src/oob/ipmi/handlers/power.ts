import { buildBaseCommand } from '../command.js';
import type { IPMIDevice } from '../device.js';
import type { IPMIResult } from '../result.js';
import { run as transportRun } from '../transport.js';
import { IPMIValidationError } from '../validation.js';

const POWER_OPS: readonly string[] = ['on', 'off', 'soft', 'status', 'cycle', 'reset'];
const IDEMPOTENT_OPS: readonly string[] = ['on', 'off', 'soft'];
const BOOT_TARGETS: readonly string[] = ['disk', 'bios', 'pxe', 'cdrom'];

const IDEMPOTENT_STDERR_MARKERS: readonly string[] = [
  'Command not supported in present state',
  'Unable to establish IPMI v2 / RMCP+ session',
  'Node busy',
];

export function maybeSynthesizeIdempotentOk(result: IPMIResult, op: string): IPMIResult {
  if (result.ok || !IDEMPOTENT_OPS.includes(op)) return result;
  const stderr = result.stderr || '';
  if (!IDEMPOTENT_STDERR_MARKERS.some((marker) => stderr.includes(marker))) return result;
  return {
    ok: true,
    stdout: `Power ${op} — already in desired state or transitioning`,
    stderr: result.stderr,
    returncode: result.returncode,
    command: [...result.command],
    cipherUsed: result.cipherUsed,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
  };
}

export interface PowerOptions {
  timeout?: number;
}

export async function power(device: IPMIDevice, op: string, opts: PowerOptions = {}): Promise<IPMIResult> {
  const timeout = opts.timeout ?? 30;
  if (!POWER_OPS.includes(op)) {
    throw new IPMIValidationError(`Unknown power operation: ${op}`);
  }
  const command = [...buildBaseCommand(device), 'power', op];
  const result = await transportRun(command, device.password, timeout, {
    cipherUsed: device.cipher,
    jobId: device.jobId,
  });
  return maybeSynthesizeIdempotentOk(result, op);
}

export async function powerStatus(device: IPMIDevice, opts: PowerOptions = {}): Promise<'on' | 'off' | null> {
  const result = await power(device, 'status', opts);
  if (!result.ok) return null;
  const text = result.stdout.toLowerCase();
  if (text.includes('power is on')) return 'on';
  if (text.includes('power is off')) return 'off';
  return null;
}

export async function shouldExecutePowerOp(device: IPMIDevice, op: string, opts: PowerOptions = {}): Promise<boolean> {
  if (!IDEMPOTENT_OPS.includes(op)) return true;
  const current = await powerStatus(device, opts);
  if (current === null) return true;
  if (op === 'on' && current === 'on') return false;
  if ((op === 'off' || op === 'soft') && current === 'off') return false;
  return true;
}

export async function getBootParam(
  device: IPMIDevice,
  paramNumber: number,
  opts: PowerOptions = {},
): Promise<IPMIResult> {
  const timeout = opts.timeout ?? 30;
  const command = [...buildBaseCommand(device), 'chassis', 'bootparam', 'get', String(paramNumber)];
  return transportRun(command, device.password, timeout, { cipherUsed: device.cipher, jobId: device.jobId });
}

export interface BootDeviceOptions extends PowerOptions {
  uefi?: boolean;
  persistent?: boolean;
}

export async function bootDevice(
  device: IPMIDevice,
  target: string,
  opts: BootDeviceOptions = {},
): Promise<IPMIResult> {
  const timeout = opts.timeout ?? 30;
  const uefi = opts.uefi ?? true;
  const persistent = opts.persistent ?? true;
  if (!BOOT_TARGETS.includes(target)) {
    throw new IPMIValidationError(`Unknown boot device target: ${target}`);
  }
  const flags: string[] = [];
  if (persistent) flags.push('persistent');
  if (uefi) flags.push('efiboot');
  const command = [...buildBaseCommand(device), 'chassis', 'bootdev', target];
  // A bare `options=` is malformed, so drop the argument entirely when no flag applies.
  if (flags.length > 0) command.push(`options=${flags.join(',')}`);
  return transportRun(command, device.password, timeout, { cipherUsed: device.cipher, jobId: device.jobId });
}
