import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const home = mkdtempSync(join(tmpdir(), 'brokkr-cli-home-'));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => home, default: { ...actual, homedir: () => home } };
});

const { getConfig, saveConfig, setEnvApiKey, getEnvApiKey, clearEnvApiKey, invalidateConfigCache } = await import(
  '../env.js'
);

describe('clearEnvApiKey', () => {
  beforeEach(() => {
    saveConfig({ activeEnv: 'local', environments: { local: { apiUrl: 'http://localhost:3000' } } });
    invalidateConfigCache();
  });

  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('removes a persisted env api key so getEnvApiKey returns nothing', () => {
    setEnvApiKey('brk_secret');
    expect(getEnvApiKey()).toBe('brk_secret');

    clearEnvApiKey();
    expect(getEnvApiKey()).toBeUndefined();

    invalidateConfigCache();
    expect(getConfig().environments['local']?.apiKey).toBeUndefined();
  });

  it('is a no-op when no api key is set', () => {
    expect(() => clearEnvApiKey()).not.toThrow();
    expect(getEnvApiKey()).toBeUndefined();
  });
});
