import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach } from 'vitest';

import { engineRoot, resetEngineRootCache } from '../engine-root';

const REAL_ENGINE_ROOT = join(process.cwd(), '..', 'local-sim');

const ORIG = { ...process.env };
afterEach(() => {
  process.env = { ...ORIG };
  resetEngineRootCache();
});

describe('engineRoot', () => {
  it('prefers the LOCAL_BROKKR_ROOT override when it points at a valid engine', () => {
    process.env.LOCAL_BROKKR_ROOT = REAL_ENGINE_ROOT;
    expect(engineRoot()).toBe(REAL_ENGINE_ROOT);
  });

  it('falls back to the sibling apps/local-sim directory', () => {
    delete process.env.LOCAL_BROKKR_ROOT;
    const root = engineRoot();
    expect(root.endsWith(`${sep}local-sim`)).toBe(true);
    expect(root).toBe(REAL_ENGINE_ROOT);
  });

  it('throws a descriptive error naming the path and env var when the engine is missing', () => {
    const empty = mkdtempSync(join(tmpdir(), 'engine-root-'));
    process.env.LOCAL_BROKKR_ROOT = empty;
    try {
      expect(() => engineRoot()).toThrow(empty);
      expect(() => engineRoot()).toThrow(/LOCAL_BROKKR_ROOT/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
