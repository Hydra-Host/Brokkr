import { constants as fsConstants } from 'node:fs';
import { access, readFile as fsReadFile } from 'node:fs/promises';

import { run } from '../../exec';

export type HealthSection = Record<string, unknown>;

export class ShellError extends Error {
  constructor(
    public script: string,
    public exit_code: number,
    public stdout: string,
    public stderr: string,
  ) {
    super(`Command failed (exit=${exit_code}): ${script}\nstderr: ${stderr.trim()}`);
  }
}

const SHELL = '/bin/sh';

export async function sh(script: string, timeoutMs = 60_000): Promise<string> {
  const result = await run(SHELL, ['-c', script], { timeout_ms: timeoutMs });
  if (result.exit_code !== 0) {
    throw new ShellError(script, result.exit_code, result.stdout, result.stderr);
  }
  return result.stdout;
}

export async function runStrict(cmd: string, args: readonly string[], timeoutMs = 60_000): Promise<string> {
  const result = await run(cmd, args, { timeout_ms: timeoutMs });
  if (result.exit_code !== 0) {
    const printable = [cmd, ...args].join(' ');
    throw new ShellError(printable, result.exit_code, result.stdout, result.stderr);
  }
  return result.stdout;
}

export async function tryShell(script: string, timeoutMs = 60_000): Promise<string | undefined> {
  try {
    const result = await run(SHELL, ['-c', script], { timeout_ms: timeoutMs });
    if (result.exit_code !== 0) return undefined;
    return result.stdout;
  } catch {
    return undefined;
  }
}

export async function readFile(path: string): Promise<string> {
  return fsReadFile(path, 'utf8');
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function numOr(value: unknown, fallback = 0): number {
  return typeof value === 'number' && !Number.isNaN(value) ? value : fallback;
}

export function parseSlashDate(dateStr: string): Date | null {
  const mdy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;

  const mdyMatch = dateStr.match(mdy);
  if (mdyMatch) {
    const month = Number.parseInt(mdyMatch[1]!, 10);
    const day = Number.parseInt(mdyMatch[2]!, 10);
    const year = Number.parseInt(mdyMatch[3]!, 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return new Date(Date.UTC(year, month - 1, day));
    }
  }

  const isoMatch = dateStr.match(iso);
  if (isoMatch) {
    const year = Number.parseInt(isoMatch[1]!, 10);
    const month = Number.parseInt(isoMatch[2]!, 10);
    const day = Number.parseInt(isoMatch[3]!, 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return new Date(Date.UTC(year, month - 1, day));
    }
  }

  if (mdyMatch) {
    const day = Number.parseInt(mdyMatch[1]!, 10);
    const month = Number.parseInt(mdyMatch[2]!, 10);
    const year = Number.parseInt(mdyMatch[3]!, 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return new Date(Date.UTC(year, month - 1, day));
    }
  }

  return null;
}
