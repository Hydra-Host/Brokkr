import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RESULTS_ROOT, resultsRootBelongsToStateDir } from '../../results-root';
import { RunResultsStore } from '../run-results-store';

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'lab-containment-'));
  vi.stubEnv('LOCAL_STATE', stateDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(stateDir, { recursive: true, force: true });
});

describe('resultsRootBelongsToStateDir', () => {
  it('rejects the home default when LOCAL_STATE points somewhere else', () => {
    expect(resultsRootBelongsToStateDir(stateDir)).toBe(false);
  });

  it('accepts the root that the state dir actually owns', () => {
    expect(resultsRootBelongsToStateDir(RESULTS_ROOT)).toBe(true);
  });

  it('is not fooled by a sibling whose name shares a prefix', () => {
    expect(resultsRootBelongsToStateDir(`${RESULTS_ROOT}-elsewhere`)).toBe(false);
  });

  it('refuses a root stubbed after import, which the captured root does not reflect', () => {
    vi.stubEnv('LOCAL_BROKKR_ALLURE', join(stateDir, 'late'));
    expect(resultsRootBelongsToStateDir(stateDir)).toBe(false);
  });
});

describe('RunResultsStore containment', () => {
  function withCanary(runId: string, assert: (dir: string) => void): void {
    const canary = join(RESULTS_ROOT, `${runId}-results`);
    mkdirSync(canary, { recursive: true });
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    utimesSync(canary, old, old);

    try {
      assert(canary);
    } finally {
      rmSync(canary, { recursive: true, force: true });
    }
  }

  it('declines to sweep a results root the state dir does not own', () => {
    withCanary('containment-canary', (dir) => {
      expect(new RunResultsStore().removeOrphans(new Set())).toBe(0);
      expect(existsSync(dir)).toBe(true);
    });
  });

  it('declines a targeted delete under the same mismatched root', () => {
    withCanary('containment-targeted', (dir) => {
      expect(new RunResultsStore().remove('containment-targeted')).toBe(false);
      expect(existsSync(dir)).toBe(true);
    });
  });
});
