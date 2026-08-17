import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());
const readFileSyncMock = vi.hoisted(() => vi.fn());
const statSyncMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const execFile = (...args: unknown[]) => execFileMock(...args);
  Object.defineProperty(execFile, promisify.custom, { value: execFileMock, configurable: true });
  return { ...actual, execFile };
});

vi.mock('node:fs', async (orig) => ({
  ...(await orig<typeof import('node:fs')>()),
  readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
  statSync: (...args: unknown[]) => statSyncMock(...args),
}));

import { ccBuildInfo, invalidateCcBuildHead, resetCcBuildCaches } from '../build-info';

const stampJson = (sha: string, builtAt: number) => JSON.stringify({ sha, builtAt });

describe('ccBuildInfo', () => {
  beforeEach(() => {
    execFileMock.mockReset();
    readFileSyncMock.mockReset();
    statSyncMock.mockReset();
    statSyncMock.mockReturnValue({ mtimeMs: 0 });
    resetCcBuildCaches();
  });

  it('reads the build stamp and reports no skew when HEAD matches', async () => {
    readFileSyncMock.mockReturnValue(stampJson('aaa', 1_700_000_000_000));
    execFileMock.mockResolvedValue({ stdout: 'aaa\n', stderr: '' });
    expect(await ccBuildInfo()).toEqual({ sha: 'aaa', builtAt: 1_700_000_000_000, headSha: 'aaa', stale: false });
  });

  it('flags stale when the checkout HEAD moved past the build', async () => {
    readFileSyncMock.mockReturnValue(stampJson('aaa', 1_700_000_000_000));
    execFileMock.mockResolvedValue({ stdout: 'bbb\n', stderr: '' });
    expect((await ccBuildInfo()).stale).toBe(true);
  });

  it('falls back to HEAD-at-start and the dist mtime when dist/main.js is newer than the stamp', async () => {
    readFileSyncMock.mockReturnValue(stampJson('aaa', 1_700_000_000_000));
    statSyncMock.mockImplementation((path: string) =>
      path.toString().endsWith('build-info.json') ? { mtimeMs: 1_700_000_000_000 } : { mtimeMs: 1_700_000_001_000 },
    );
    execFileMock.mockResolvedValue({ stdout: 'ccc\n', stderr: '' });
    expect(await ccBuildInfo()).toEqual({ sha: 'ccc', builtAt: 1_700_000_001_000, headSha: 'ccc', stale: false });
  });

  it('uses the build stamp when it is newer than dist/main.js', async () => {
    readFileSyncMock.mockReturnValue(stampJson('aaa', 1_700_000_000_000));
    statSyncMock.mockImplementation((path: string) =>
      path.toString().endsWith('build-info.json') ? { mtimeMs: 1_700_000_002_000 } : { mtimeMs: 1_700_000_000_000 },
    );
    execFileMock.mockResolvedValue({ stdout: 'aaa\n', stderr: '' });
    expect(await ccBuildInfo()).toEqual({ sha: 'aaa', builtAt: 1_700_000_000_000, headSha: 'aaa', stale: false });
  });

  it('falls back to HEAD-at-start and the dist mtime when the stamp is missing', async () => {
    readFileSyncMock.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    statSyncMock.mockReturnValue({ mtimeMs: 1_700_000_000_000 });
    execFileMock.mockResolvedValue({ stdout: 'ccc\n', stderr: '' });
    expect(await ccBuildInfo()).toEqual({ sha: 'ccc', builtAt: 1_700_000_000_000, headSha: 'ccc', stale: false });
  });

  it('never flags stale when a side is unknown', async () => {
    readFileSyncMock.mockReturnValue('not json');
    statSyncMock.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    execFileMock.mockRejectedValue(new Error('not a git repository'));
    expect(await ccBuildInfo()).toEqual({ sha: null, builtAt: null, headSha: null, stale: false });
  });

  it('caches the stamp for the process and the head only within its TTL', async () => {
    readFileSyncMock.mockReturnValue(stampJson('aaa', 1));
    execFileMock.mockResolvedValue({ stdout: 'aaa\n', stderr: '' });
    await ccBuildInfo();
    await ccBuildInfo();
    expect(readFileSyncMock).toHaveBeenCalledTimes(1);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it('invalidateCcBuildHead forces a fresh head read after a checkout', async () => {
    readFileSyncMock.mockReturnValue(stampJson('aaa', 1));
    execFileMock.mockResolvedValue({ stdout: 'aaa\n', stderr: '' });
    await ccBuildInfo();
    execFileMock.mockResolvedValue({ stdout: 'bbb\n', stderr: '' });
    invalidateCcBuildHead();
    expect((await ccBuildInfo()).stale).toBe(true);
  });
});
