import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

import { devenvRoot } from './paths';

export const RestartWipeSchema = z.enum(['stack-wipe-data', 'stack-reset', 'stack-purge', 'stack-reslot']);
export type RestartWipe = z.infer<typeof RestartWipeSchema>;

export const RestartMarkerSchema = z.object({
  opId: z.string(),
  runId: z.string(),
  reason: z.string(),
  wipe: RestartWipeSchema.optional(),
  startedAt: z.number(),
  logPath: z.string(),
});
export type RestartMarker = z.infer<typeof RestartMarkerSchema>;

const ExitCodeSchema = z.coerce.number().int();

// $DEVENV_STATE survives stack-wipe-data/reset/purge (they only rm named subpaths), so a marker
// written before a wipe is still there to read after the stack comes back.
function stateFile(name: string): string | null {
  const state = process.env.DEVENV_STATE;
  return state ? join(state, name) : null;
}

export function restartMarkerPath(): string | null {
  return stateFile('lab-restart.json');
}

export function restartExitPath(): string | null {
  return stateFile('lab-restart.exit');
}

export function restartLogPath(): string {
  return stateFile('lab-restart.log') ?? join(devenvRoot(), '.devenv', 'lab-restart.log');
}

export function writeRestartMarker(marker: RestartMarker): void {
  const path = restartMarkerPath();
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(marker));
  renameSync(tmp, path);
  clearRestartExit();
}

export function readRestartMarker(): RestartMarker | null {
  const path = restartMarkerPath();
  if (!path) return null;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = RestartMarkerSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

export function clearRestartMarker(): void {
  const path = restartMarkerPath();
  if (path) rmSync(path, { force: true });
}

export function clearRestartExit(): void {
  const path = restartExitPath();
  if (path) rmSync(path, { force: true });
}

/** The child appends its own final exit code, so a bring-up that failed while the API was down is
 *  distinguishable from one still in progress. Last line wins. */
export function readRestartExit(): number | null {
  const path = restartExitPath();
  if (!path) return null;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1];
  if (last === undefined) return null;
  const result = ExitCodeSchema.safeParse(last);
  return result.success ? result.data : null;
}
