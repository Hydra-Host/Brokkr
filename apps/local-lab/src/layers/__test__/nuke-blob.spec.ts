import { BadRequestException } from '@nestjs/common';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const overrides = vi.hoisted((): { unlink: ((p: string) => void) | null } => ({ unlink: null }));
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>();
  return {
    ...actual,
    unlinkSync: (p: string) => (overrides.unlink ? overrides.unlink(p) : actual.unlinkSync(p)),
  };
});

import { LayerCacheService } from '../layer-cache.service';

describe('LayerCacheService.nukeBlob', () => {
  const shaX = 'a'.repeat(64);
  const shaY = 'b'.repeat(64);
  let stateDir: string;
  let cacheDir: string;

  const writeBlob = (rel: string, sha: string): void => {
    const full = join(cacheDir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, Buffer.from(`KEY: /os-layers/blobs/sha256:${sha}\n`, 'latin1'));
  };
  const writeRaw = (rel: string, content: string): void => {
    const full = join(cacheDir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  };
  const svc = (): LayerCacheService => new LayerCacheService({} as never);

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'nuke-state-'));
    cacheDir = join(stateDir, 'nginx', 'layer-cache');
    mkdirSync(cacheDir, { recursive: true });
    vi.stubEnv('DEVENV_STATE', stateDir);
  });
  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    overrides.unlink = null;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('deletes every file carrying the target sha, not just the first', async () => {
    writeBlob('a/00/1', shaX);
    writeBlob('b/00/2', shaX);
    await expect(svc().nukeBlob(shaX)).resolves.toBe(true);
    expect(existsSync(join(cacheDir, 'a/00/1'))).toBe(false);
    expect(existsSync(join(cacheDir, 'b/00/2'))).toBe(false);
  });

  it('preserves non-matching and headerless files', async () => {
    writeBlob('a/00/1', shaX);
    writeBlob('b/00/2', shaY);
    writeRaw('c/00/3', 'no cache header here');
    await expect(svc().nukeBlob(shaX)).resolves.toBe(true);
    expect(existsSync(join(cacheDir, 'a/00/1'))).toBe(false);
    expect(existsSync(join(cacheDir, 'b/00/2'))).toBe(true);
    expect(existsSync(join(cacheDir, 'c/00/3'))).toBe(true);
  });

  it('does not follow directory symlinks and never removes the symlink entry', async () => {
    writeBlob('a/00/1', shaX);
    symlinkSync(cacheDir, join(cacheDir, 'cycle'), 'dir');
    await expect(svc().nukeBlob(shaX)).resolves.toBe(true);
    expect(existsSync(join(cacheDir, 'a/00/1'))).toBe(false);
    expect(lstatSync(join(cacheDir, 'cycle')).isSymbolicLink()).toBe(true);
  });

  it('returns true when the cache dir does not exist', async () => {
    vi.stubEnv('DEVENV_STATE', '');
    await expect(svc().nukeBlob(shaX)).resolves.toBe(true);
  });

  it('rejects a malformed sha with 400', async () => {
    await expect(svc().nukeBlob('not-a-sha')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('returns true when nothing matches', async () => {
    writeBlob('a/00/1', shaY);
    await expect(svc().nukeBlob(shaX)).resolves.toBe(true);
    expect(existsSync(join(cacheDir, 'a/00/1'))).toBe(true);
  });

  it('ignores an ENOENT during unlink', async () => {
    writeBlob('a/00/1', shaX);
    overrides.unlink = () => {
      throw Object.assign(new Error('gone'), { code: 'ENOENT' });
    };
    await expect(svc().nukeBlob(shaX)).resolves.toBe(true);
  });

  it('rethrows a non-ENOENT unlink error', async () => {
    writeBlob('a/00/1', shaX);
    overrides.unlink = () => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    };
    await expect(svc().nukeBlob(shaX)).rejects.toThrow(/denied/);
  });

  it('returns true when DEVENV_STATE is set but the cache dir is absent', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'nuke-bare-'));
    vi.stubEnv('DEVENV_STATE', bare);
    await expect(svc().nukeBlob(shaX)).resolves.toBe(true);
    rmSync(bare, { recursive: true, force: true });
  });
});
