import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, vi } from 'vitest';

const liveOverlayPath = (): string | null => {
  const state = process.env.DEVENV_STATE;
  return state ? join(state, 'lab', 'overlay-process-compose.yaml') : null;
};

const stampOf = (path: string | null): number | null => {
  if (!path) return null;
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
};

export const scratchTmpDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'lab-scratch-'));
  vi.stubEnv('TMPDIR', dir);
  return dir;
};

export function useScratchState(): () => string {
  let dir = '';
  let live: string | null = null;
  let stamp: number | null = null;

  beforeEach(() => {
    live = liveOverlayPath();
    stamp = stampOf(live);
    dir = mkdtempSync(join(tmpdir(), 'lab-state-'));
    vi.stubEnv('DEVENV_STATE', dir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    expect({ liveOverlayTouched: stampOf(live) !== stamp }).toEqual({ liveOverlayTouched: false });
  });

  return () => dir;
}
