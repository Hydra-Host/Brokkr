import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../exec', () => ({
  run: vi.fn(),
}));

import { clearOperationsForTests, getHandler } from '../../../dispatch/registry';
import { run } from '../../../exec';
import { registerGrubInstaller } from '.././grub';

const runMock = vi.mocked(run);
const ctx = {} as never;

const OK = { exit_code: 0, stdout: '', stderr: '', duration_ms: 0 };

const VALID_GRUB_CFG = [
  'set timeout=5',
  'menuentry "Ubuntu" {',
  '\tlinux /boot/vmlinuz root=UUID=abc-123 ro quiet',
  '}',
].join('\n');

function happyPathMock() {
  runMock.mockImplementation(async (cmd, args) => {
    if (cmd === 'chroot' && (args ?? []).includes('cat')) {
      return { ...OK, stdout: VALID_GRUB_CFG };
    }
    return OK;
  });
}

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'grub-test-'));
  runMock.mockReset();
  happyPathMock();
  clearOperationsForTests();
  registerGrubInstaller();
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

const spawned = (): Array<[string, readonly string[]]> =>
  runMock.mock.calls.map(([c, a]) => [c as string, (a ?? []) as readonly string[]]);

describe('deploy.installGrub (UEFI)', () => {
  beforeEach(async () => {
    for (const binary of ['boot/efi/EFI/ubuntu/grubx64.efi', 'boot/efi/EFI/ubuntu/grubaa64.efi']) {
      await mkdir(join(tmpRoot, binary, '..'), { recursive: true });
      await writeFile(join(tmpRoot, binary), 'efi');
    }
  });

  const uefiInput = (purgeTtys = false) => ({
    target_path: tmpRoot,
    arch: 'amd64' as const,
    uefi: true,
    distro: 'ubuntu',
    grub_disks: [],
    grub_defaults: 'GRUB_DEFAULT=0\nGRUB_TIMEOUT=5\n',
    grub_fallback_cfg: 'menuentry chainload {\n}\n',
    purge_ttys: purgeTtys,
  });

  it('runs the full UEFI sequence in order for amd64', async () => {
    const handler = getHandler('deploy.installGrub')!.handler;
    const result = await handler(uefiInput(), ctx);

    expect(result).toEqual({ installed_targets: ['x86_64-efi'] });

    const calls = spawned();
    const chrootCalls = calls.filter(
      ([c, a]) => c === 'chroot' && !(a ?? []).includes('dpkg-divert') && !(a ?? []).includes('cat'),
    );
    expect(chrootCalls).toHaveLength(4);
    expect(chrootCalls[0]![1]).toEqual([tmpRoot, 'debconf-set-selections']);
    expect(chrootCalls[1]![1]).toEqual([
      tmpRoot,
      'grub-install',
      '--target=x86_64-efi',
      '--efi-directory=/boot/efi',
      '--bootloader-id=ubuntu',
      '--no-nvram',
      '--recheck',
    ]);
    expect(chrootCalls[2]![1]).toEqual([tmpRoot, 'update-grub']);
    expect(chrootCalls[3]![1]).toEqual(chrootCalls[1]![1]);

    const mkstandalone = calls.find(([c]) => c === 'grub-mkstandalone');
    expect(mkstandalone).toBeDefined();
    expect(mkstandalone![1]).toContain('-O');
    expect(mkstandalone![1]).toContain('x86_64-efi');
    expect(mkstandalone![1]).toContain(join(tmpRoot, 'boot/efi/EFI/BOOT/BOOTX64.EFI'));
    const cfgMapping = (mkstandalone![1] as string[]).find((a) => a.startsWith('boot/grub/grub.cfg='));
    expect(cfgMapping).toMatch(/^boot\/grub\/grub\.cfg=\/.*grub-fallback.*\/grub-fallback\.cfg$/);
  });

  it('uses BOOTAA64.EFI and arm64-efi target for arm64', async () => {
    const handler = getHandler('deploy.installGrub')!.handler;
    const result = await handler(
      {
        target_path: tmpRoot,
        arch: 'arm64',
        uefi: true,
        distro: 'ubuntu',
        grub_disks: [],
        grub_defaults: '',
        grub_fallback_cfg: 'cfg',
        purge_ttys: false,
      },
      ctx,
    );

    expect(result).toEqual({ installed_targets: ['arm64-efi'] });

    const calls = spawned();
    const mkstandalone = calls.find(([c]) => c === 'grub-mkstandalone');
    expect(mkstandalone![1]).toContain(join(tmpRoot, 'boot/efi/EFI/BOOT/BOOTAA64.EFI'));
    expect(mkstandalone![1]).toContain('arm64-efi');
  });

  it('writes /etc/default/grub with the rendered content', async () => {
    const handler = getHandler('deploy.installGrub')!.handler;
    await handler(uefiInput(), ctx);

    const content = await readFile(join(tmpRoot, 'etc/default/grub'), 'utf-8');
    expect(content).toBe('GRUB_DEFAULT=0\nGRUB_TIMEOUT=5\n');
  });

  it('runs the ttyS-purge sed in chroot when purge_ttys=true', async () => {
    const handler = getHandler('deploy.installGrub')!.handler;
    await handler(uefiInput(true), ctx);

    const sedCall = runMock.mock.calls.find(([c, a]) => c === 'chroot' && (a ?? []).includes('sed'));
    expect(sedCall).toBeDefined();
    expect(sedCall![1]).toEqual([
      tmpRoot,
      'sed',
      '-i',
      '-E',
      's/ console=ttyS[0-9]+(,[^ ]*)?//g',
      '/etc/default/grub.d/50-cloudimg-settings.cfg',
    ]);
  });

  it('skips the sed when purge_ttys=false', async () => {
    const handler = getHandler('deploy.installGrub')!.handler;
    await handler(uefiInput(false), ctx);

    const sedCall = runMock.mock.calls.find(([c, a]) => c === 'chroot' && (a ?? []).includes('sed'));
    expect(sedCall).toBeUndefined();
  });

  it('throws when grub-install exits non-zero', async () => {
    runMock.mockImplementation(async (cmd, args) => {
      if (cmd === 'chroot' && (args ?? []).includes('grub-install')) {
        return { ...OK, exit_code: 1, stderr: 'install failed' };
      }
      return OK;
    });
    const handler = getHandler('deploy.installGrub')!.handler;
    await expect(handler(uefiInput(), ctx)).rejects.toThrow(/grub-install.*failed/);
  });

  it('throws when grub-install exits 0 but writes no EFI binary (silent skip)', async () => {
    await rm(join(tmpRoot, 'boot/efi/EFI/ubuntu/grubx64.efi'), { force: true });
    const handler = getHandler('deploy.installGrub')!.handler;
    await expect(handler(uefiInput(), ctx)).rejects.toThrow(/produced no .*grubx64\.efi/);
  });

  it('throws when grub-mkstandalone exits non-zero', async () => {
    runMock.mockImplementation(async (cmd) => {
      if (cmd === 'grub-mkstandalone') {
        return { ...OK, exit_code: 2, stderr: 'no such target' };
      }
      return OK;
    });
    const handler = getHandler('deploy.installGrub')!.handler;
    await expect(handler(uefiInput(), ctx)).rejects.toThrow(/grub-mkstandalone failed/);
  });
});

describe('deploy.installGrub (Legacy BIOS)', () => {
  it('runs grub-install --target=i386-pc for each grub_disk', async () => {
    const handler = getHandler('deploy.installGrub')!.handler;
    const result = await handler(
      {
        target_path: tmpRoot,
        arch: 'amd64',
        uefi: false,
        distro: 'ubuntu',
        grub_disks: ['/dev/sda', '/dev/sdb'],
        grub_defaults: 'GRUB_DEFAULT=0\n',
        purge_ttys: false,
      },
      ctx,
    );

    expect(result).toEqual({
      installed_targets: ['i386-pc:/dev/sda', 'i386-pc:/dev/sdb'],
    });

    const installCalls = runMock.mock.calls.filter(([c, a]) => c === 'chroot' && (a ?? []).includes('grub-install'));
    expect(installCalls).toHaveLength(2);
    expect(installCalls[0]![1]).toEqual([
      tmpRoot,
      'grub-install',
      '--target=i386-pc',
      '--boot-directory=/boot',
      '--recheck',
      '/dev/sda',
    ]);
    expect(installCalls[1]![1]).toEqual([
      tmpRoot,
      'grub-install',
      '--target=i386-pc',
      '--boot-directory=/boot',
      '--recheck',
      '/dev/sdb',
    ]);
  });

  it('never calls grub-mkstandalone on the legacy path', async () => {
    const handler = getHandler('deploy.installGrub')!.handler;
    await handler(
      {
        target_path: tmpRoot,
        arch: 'amd64',
        uefi: false,
        distro: 'ubuntu',
        grub_disks: ['/dev/sda'],
        grub_defaults: '',
        purge_ttys: false,
      },
      ctx,
    );
    expect(runMock.mock.calls.find(([c]) => c === 'grub-mkstandalone')).toBeUndefined();
  });

  it('runs update-grub after writing defaults', async () => {
    const handler = getHandler('deploy.installGrub')!.handler;
    await handler(
      {
        target_path: tmpRoot,
        arch: 'amd64',
        uefi: false,
        distro: 'ubuntu',
        grub_disks: ['/dev/sda'],
        grub_defaults: '',
        purge_ttys: false,
      },
      ctx,
    );
    const updateGrubCall = runMock.mock.calls.find(([c, a]) => c === 'chroot' && (a ?? []).includes('update-grub'));
    expect(updateGrubCall).toBeDefined();
  });
});

describe('deploy.installGrub — cloud-image divert undo', () => {
  const DIVERTED_PATHS = [
    '/usr/sbin/grub-probe',
    '/usr/sbin/dkms',
    '/etc/kernel/postinst.d/zz-update-grub',
    '/etc/kernel/postinst.d/dkms',
  ];

  it('queries dpkg-divert for each cloud-image path before update-grub', async () => {
    const handler = getHandler('deploy.installGrub')!.handler;
    await handler(
      {
        target_path: tmpRoot,
        arch: 'amd64',
        uefi: false,
        distro: 'ubuntu',
        grub_disks: ['/dev/sda'],
        grub_defaults: '',
        purge_ttys: false,
      },
      ctx,
    );

    const listCalls = runMock.mock.calls.filter(
      ([c, a]) => c === 'chroot' && (a ?? []).includes('dpkg-divert') && (a ?? []).includes('--list'),
    );
    const queriedPaths = listCalls.map(([, a]) => (a as readonly string[])[a!.length - 1]);
    expect(queriedPaths).toEqual(DIVERTED_PATHS);
  });

  it('skips removal when no divert is in place', async () => {
    const handler = getHandler('deploy.installGrub')!.handler;
    await handler(
      {
        target_path: tmpRoot,
        arch: 'amd64',
        uefi: false,
        distro: 'ubuntu',
        grub_disks: ['/dev/sda'],
        grub_defaults: '',
        purge_ttys: false,
      },
      ctx,
    );

    const removeCalls = runMock.mock.calls.filter(
      ([c, a]) =>
        c === 'chroot' &&
        (a ?? []).includes('dpkg-divert') &&
        (a ?? []).includes('--rename') &&
        (a ?? []).includes('--remove'),
    );
    expect(removeCalls).toHaveLength(0);
  });

  it('rm + dpkg-divert --rename --remove when grub-probe is diverted, before update-grub', async () => {
    runMock.mockImplementation(async (cmd, args) => {
      const argv = args ?? [];
      if (
        cmd === 'chroot' &&
        argv.includes('dpkg-divert') &&
        argv.includes('--list') &&
        argv.includes('/usr/sbin/grub-probe')
      ) {
        return {
          ...OK,
          stdout: 'diversion of /usr/sbin/grub-probe to /usr/sbin/grub-probe.distrib by debconf\n',
        };
      }
      if (cmd === 'chroot' && argv.includes('cat')) {
        return { ...OK, stdout: VALID_GRUB_CFG };
      }
      return OK;
    });

    const handler = getHandler('deploy.installGrub')!.handler;
    await handler(
      {
        target_path: tmpRoot,
        arch: 'amd64',
        uefi: false,
        distro: 'ubuntu',
        grub_disks: ['/dev/sda'],
        grub_defaults: '',
        purge_ttys: false,
      },
      ctx,
    );

    const callsForPath = runMock.mock.calls.filter(
      ([c, a]) => c === 'chroot' && (a ?? []).includes('/usr/sbin/grub-probe'),
    );
    const ops = callsForPath.map(([, a]) => {
      const argv = a ?? [];
      if (argv.includes('rm')) return 'rm';
      if (argv.includes('--list')) return 'list';
      if (argv.includes('--remove')) return 'remove';
      return 'other';
    });
    expect(ops).toEqual(['list', 'rm', 'remove']);

    const allCalls = runMock.mock.calls;
    const updateGrubIdx = allCalls.findIndex(([c, a]) => c === 'chroot' && (a ?? []).includes('update-grub'));
    const removeIdx = allCalls.findIndex(
      ([c, a]) => c === 'chroot' && (a ?? []).includes('--remove') && (a ?? []).includes('/usr/sbin/grub-probe'),
    );
    expect(removeIdx).toBeGreaterThan(-1);
    expect(removeIdx).toBeLessThan(updateGrubIdx);
  });
});

describe('deploy.installGrub — grub.cfg bootability assertion', () => {
  it('throws when /boot/grub/grub.cfg has no `linux ... root=` line', async () => {
    const brokenCfg = ['set timeout=5', 'menuentry "Ubuntu" {', '\tlinux /boot/vmlinuz ro quiet', '}'].join('\n');
    runMock.mockImplementation(async (cmd, args) => {
      if (cmd === 'chroot' && (args ?? []).includes('cat')) {
        return { ...OK, stdout: brokenCfg };
      }
      return OK;
    });

    const handler = getHandler('deploy.installGrub')!.handler;
    await expect(
      handler(
        {
          target_path: tmpRoot,
          arch: 'amd64',
          uefi: false,
          distro: 'ubuntu',
          grub_disks: ['/dev/sda'],
          grub_defaults: '',
          purge_ttys: false,
        },
        ctx,
      ),
    ).rejects.toThrow(/empty root=/);
  });

  it('does not false-positive on grub `set root=...` (only the kernel `linux` line counts)', async () => {
    const onlyGrubSetRoot = ["set root='hd0,gpt2'", 'menuentry "Ubuntu" {', '\tlinux /boot/vmlinuz ro', '}'].join('\n');
    runMock.mockImplementation(async (cmd, args) => {
      if (cmd === 'chroot' && (args ?? []).includes('cat')) {
        return { ...OK, stdout: onlyGrubSetRoot };
      }
      return OK;
    });

    const handler = getHandler('deploy.installGrub')!.handler;
    await expect(
      handler(
        {
          target_path: tmpRoot,
          arch: 'amd64',
          uefi: false,
          distro: 'ubuntu',
          grub_disks: ['/dev/sda'],
          grub_defaults: '',
          purge_ttys: false,
        },
        ctx,
      ),
    ).rejects.toThrow(/empty root=/);
  });
});
