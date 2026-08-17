import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../exec', () => ({
  run: vi.fn(),
}));

vi.mock('node:timers/promises', async () => {
  const actual = await vi.importActual<typeof import('node:timers/promises')>('node:timers/promises');
  return { ...actual, setTimeout: async () => {} };
});

import { clearOperationsForTests, getHandler } from '../../../dispatch/registry';
import { run } from '../../../exec';
import { registerPowerCycleCleaner } from '.././cleanup';
import { registerEfiFinalizer } from '.././efi';
import { registerRoceChrootConfigurer } from '.././roce';

const runMock = vi.mocked(run);
const ctx = {} as never;
const OK = { exit_code: 0, stdout: '', stderr: '', duration_ms: 0 };

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'deploy-chunk7-'));
  runMock.mockReset();
  runMock.mockResolvedValue(OK);
  clearOperationsForTests();
  registerEfiFinalizer();
  registerRoceChrootConfigurer();
  registerPowerCycleCleaner();
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('deploy.finalizeEfi', () => {
  it('returns {skipped: true, cleaned: []} on non-UEFI systems', async () => {
    const handler = getHandler('deploy.finalizeEfi')!.handler;
    const result = await handler({ target_path: tmpRoot, uefi: false }, ctx);
    expect(result).toEqual({ skipped: true, cleaned: [] });
    expect(runMock).not.toHaveBeenCalled();
  });

  it('returns early with empty cleaned[] when /boot has no numbered EFI dirs', async () => {
    await mkdir(join(tmpRoot, 'boot/efi'), { recursive: true });
    const handler = getHandler('deploy.finalizeEfi')!.handler;
    const result = await handler({ target_path: tmpRoot, uefi: true }, ctx);
    expect(result).toEqual({ skipped: false, cleaned: [] });
    const updateGrub = runMock.mock.calls.find(([c, a]) => c === 'chroot' && (a ?? []).includes('update-grub'));
    expect(updateGrub).toBeDefined();
  });

  it('copies primary EFI into each numbered dir then unmounts + removes it', async () => {
    await mkdir(join(tmpRoot, 'boot/efi'), { recursive: true });
    await mkdir(join(tmpRoot, 'boot/efi2'), { recursive: true });
    await mkdir(join(tmpRoot, 'boot/efi3'), { recursive: true });

    const handler = getHandler('deploy.finalizeEfi')!.handler;
    const result = (await handler({ target_path: tmpRoot, uefi: true }, ctx)) as {
      cleaned: string[];
      skipped: boolean;
    };

    expect(result.skipped).toBe(false);
    expect(result.cleaned.sort()).toEqual([join(tmpRoot, 'boot/efi2'), join(tmpRoot, 'boot/efi3')].sort());

    const cpCalls = runMock.mock.calls.filter(
      ([c, a]) => c === 'chroot' && (a ?? []).some((arg) => arg.startsWith('cp -a /boot/efi/*')),
    );
    expect(cpCalls).toHaveLength(2);

    const umountCalls = runMock.mock.calls.filter(([c]) => c === 'umount');
    const umountPaths = umountCalls.map(([, a]) => (a ?? [])[0]).sort();
    expect(umountPaths).toEqual([join(tmpRoot, 'boot/efi2'), join(tmpRoot, 'boot/efi3')].sort());

    const remaining = await readdir(join(tmpRoot, 'boot'));
    expect(remaining).toEqual(['efi']);
  });

  it('skips a dir literally named "efi" (only numbered variants are cleaned)', async () => {
    await mkdir(join(tmpRoot, 'boot/efi'), { recursive: true });
    const handler = getHandler('deploy.finalizeEfi')!.handler;
    const result = (await handler({ target_path: tmpRoot, uefi: true }, ctx)) as { cleaned: string[] };
    expect(result.cleaned).toEqual([]);
  });

  it('throws when update-grub fails', async () => {
    await mkdir(join(tmpRoot, 'boot/efi'), { recursive: true });
    runMock.mockImplementation(async (cmd, args) => {
      if (cmd === 'chroot' && (args ?? []).includes('update-grub')) {
        return { ...OK, exit_code: 1, stderr: 'grub-mkconfig failed' };
      }
      return OK;
    });
    const handler = getHandler('deploy.finalizeEfi')!.handler;
    await expect(handler({ target_path: tmpRoot, uefi: true }, ctx)).rejects.toThrow(/update-grub failed/);
  });
});

describe('deploy.applyRoceChrootConfig', () => {
  it('returns success=true when the service unit does not exist (best-effort)', async () => {
    const handler = getHandler('deploy.applyRoceChrootConfig')!.handler;
    const result = await handler({ target_path: tmpRoot }, ctx);
    expect(result).toEqual({ success: true });
    expect(runMock.mock.calls.find(([c, a]) => c === 'chroot' && (a ?? []).includes('sed'))).toBeUndefined();
  });

  it('runs sed in chroot when the service unit exists', async () => {
    const unitDir = join(tmpRoot, 'usr/lib/systemd/system');
    await mkdir(unitDir, { recursive: true });
    await writeFile(
      join(unitDir, 'nvidia-persistenced.service'),
      'ExecStart=/usr/bin/nvidia-persistenced --no-persistence-mode\n',
    );

    const handler = getHandler('deploy.applyRoceChrootConfig')!.handler;
    const result = await handler({ target_path: tmpRoot }, ctx);
    expect(result).toEqual({ success: true });

    const sedCall = runMock.mock.calls.find(([c, a]) => c === 'chroot' && (a ?? []).includes('sed'));
    expect(sedCall).toBeDefined();
    expect(sedCall![1]).toEqual([
      tmpRoot,
      'sed',
      '-i',
      's/\\s*--no-persistence-mode//g',
      '/usr/lib/systemd/system/nvidia-persistenced.service',
    ]);
  });

  it('returns success=false (not throw) when sed exits non-zero', async () => {
    const unitDir = join(tmpRoot, 'usr/lib/systemd/system');
    await mkdir(unitDir, { recursive: true });
    await writeFile(join(unitDir, 'nvidia-persistenced.service'), '');
    runMock.mockResolvedValue({ ...OK, exit_code: 1, stderr: 'sed: permission denied' });

    const handler = getHandler('deploy.applyRoceChrootConfig')!.handler;
    const result = await handler({ target_path: tmpRoot }, ctx);
    expect(result).toEqual({ success: false });
  });
});

describe('deploy.powerCycleCleanup', () => {
  it('removes *-is-merged files at the top of target_path', async () => {
    await writeFile(join(tmpRoot, 'usr-is-merged'), '');
    await writeFile(join(tmpRoot, 'var-is-merged'), '');
    await writeFile(join(tmpRoot, 'not-a-merge-marker'), 'keep');

    const handler = getHandler('deploy.powerCycleCleanup')!.handler;
    await handler({ target_path: tmpRoot }, ctx);

    const remaining = await readdir(tmpRoot);
    expect(remaining.sort()).toEqual(['not-a-merge-marker']);
  });

  it('removes numbered /boot/efiN directories but keeps /boot/efi', async () => {
    await mkdir(join(tmpRoot, 'boot/efi'), { recursive: true });
    await mkdir(join(tmpRoot, 'boot/efi2'), { recursive: true });
    await mkdir(join(tmpRoot, 'boot/efi3'), { recursive: true });
    await mkdir(join(tmpRoot, 'boot/not-efi-dir'), { recursive: true });

    const handler = getHandler('deploy.powerCycleCleanup')!.handler;
    await handler({ target_path: tmpRoot }, ctx);

    const remaining = await readdir(join(tmpRoot, 'boot'));
    expect(remaining.sort()).toEqual(['efi', 'not-efi-dir']);
  });

  it('runs xfs_freeze -f then -u', async () => {
    const handler = getHandler('deploy.powerCycleCleanup')!.handler;
    await handler({ target_path: tmpRoot }, ctx);

    const freezeCalls = runMock.mock.calls.filter(([c]) => c === 'xfs_freeze');
    expect(freezeCalls).toHaveLength(2);
    expect(freezeCalls[0]![1]).toEqual(['-f', tmpRoot]);
    expect(freezeCalls[1]![1]).toEqual(['-u', tmpRoot]);
  });

  it('runs chroot sync', async () => {
    const handler = getHandler('deploy.powerCycleCleanup')!.handler;
    await handler({ target_path: tmpRoot }, ctx);

    const chrootSyncCall = runMock.mock.calls.find(([c, a]) => c === 'chroot' && (a ?? []).includes('sync'));
    expect(chrootSyncCall).toBeDefined();
  });

  it('never throws even when every command fails', async () => {
    runMock.mockResolvedValue({ ...OK, exit_code: 1, stderr: 'everything broken' });

    const handler = getHandler('deploy.powerCycleCleanup')!.handler;
    const result = await handler({ target_path: tmpRoot }, ctx);
    expect(result).toEqual({ success: true });
  });
}, 15_000);
