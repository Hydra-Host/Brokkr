import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import type { IPMIDevice } from './device.js';

const FALLBACK_BIN = '/usr/bin/ipmitool';

function which(name: string): string | null {
  // eslint-disable-next-line turbo/no-undeclared-env-vars -- system PATH, not a build input
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.F_OK | constants.X_OK);
      if (statSync(candidate).isDirectory()) continue;
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

export function resolveIpmitoolBin(): string {
  return process.env.IPMITOOL_BIN || which('ipmitool') || FALLBACK_BIN;
}

let cachedBin: string | null = null;

export function ipmitoolBin(): string {
  cachedBin ??= resolveIpmitoolBin();
  return cachedBin;
}

export function resetIpmitoolBin(): void {
  cachedBin = null;
}

export function buildBaseCommand(device: IPMIDevice, bin: string = ipmitoolBin()): string[] {
  const cmd = [
    bin,
    '-H',
    device.ip,
    '-U',
    device.username,
    '-P',
    device.password,
    '-p',
    String(device.port),
    '-I',
    'lanplus',
  ];
  if (device.cipher) {
    cmd.push(`-C${device.cipher}`);
  }
  return cmd;
}

export function withCsvFlag(base: readonly string[]): string[] {
  const [bin, ...rest] = base;
  if (bin === undefined) {
    throw new Error('Empty command');
  }
  return [bin, '-c', ...rest];
}
