import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const home = mkdtempSync(join(tmpdir(), 'brokkr-cli-home-'));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => home, default: { ...actual, homedir: () => home } };
});

vi.mock('../../core/auth.js', () => ({
  logout: vi.fn().mockResolvedValue(undefined),
  getSession: vi.fn(),
  isTwoFactorRequired: vi.fn(),
  login: vi.fn(),
  verifyApiKey: vi.fn(),
  verifyTotp: vi.fn(),
}));

const { registerAuthCommands } = await import('../auth.js');
const { saveConfig, setEnvApiKey, getEnvApiKey, invalidateConfigCache } = await import('../../config/env.js');
const { saveSession, getSession, invalidateSessionCaches } = await import('../../config/store.js');
const authCore = await import('../../core/auth.js');

async function runLogout(opts?: { isBridge?: boolean }): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerAuthCommands(program, opts);
  await program.parseAsync(['logout'], { from: 'user' });
}

describe('logout command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    delete process.env['BROKKR_BRIDGE'];
    invalidateConfigCache();
    invalidateSessionCaches();
  });

  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('purges the persisted env api-key fallback (non-bridge path)', async () => {
    saveConfig({ activeEnv: 'local', environments: { local: { apiUrl: 'http://localhost:3000' } } });
    invalidateConfigCache();
    setEnvApiKey('brk_secret');
    saveSession({ cookie: 'cookie-abc', email: 'you@example.com', userId: 'u1' });
    expect(getEnvApiKey()).toBe('brk_secret');

    await runLogout();

    expect(getSession()).toBeNull();
    expect(getEnvApiKey()).toBeUndefined();
    invalidateConfigCache();
    expect(getEnvApiKey()).toBeUndefined();
  });

  it('clears the env key even when there is no active session', async () => {
    saveConfig({ activeEnv: 'local', environments: { local: { apiUrl: 'http://localhost:3000' } } });
    invalidateConfigCache();
    setEnvApiKey('brk_orphan');
    expect(getEnvApiKey()).toBe('brk_orphan');

    await runLogout();

    expect(getEnvApiKey()).toBeUndefined();
    expect(authCore.logout).not.toHaveBeenCalled();
  });

  it('leaves the env key untouched in bridge mode (browser owns the session)', async () => {
    saveConfig({
      activeEnv: 'local',
      environments: { local: { apiUrl: 'http://localhost:3000', connectionMode: 'bridge' } },
    });
    invalidateConfigCache();
    setEnvApiKey('brk_bridge');
    expect(getEnvApiKey()).toBe('brk_bridge');

    await runLogout({ isBridge: true });

    expect(getEnvApiKey()).toBe('brk_bridge');
    expect(authCore.logout).not.toHaveBeenCalled();
  });
});
