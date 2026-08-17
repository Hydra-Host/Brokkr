import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerOperation } from '../../dispatch/registry';
import { run } from '../../exec';
import { makeLogger } from '../../logger';
import { assertTargetPathSafe } from './targetPath';
const logger = makeLogger('deploy');

type Architecture = 'amd64' | 'arm64';

interface ArchGrubTargets {
  efiTarget: string;
  efiFallback: string;
  grubEfi: string;
}

const ARCH_TARGETS: Record<Architecture, ArchGrubTargets> = {
  amd64: { efiTarget: 'x86_64-efi', efiFallback: 'BOOTX64.EFI', grubEfi: 'grubx64.efi' },
  arm64: { efiTarget: 'arm64-efi', efiFallback: 'BOOTAA64.EFI', grubEfi: 'grubaa64.efi' },
};

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

// Cloud-image layers divert these to /bin/true; if present, update-grub produces empty root= and breaks boot.
const CLOUD_IMAGE_DIVERTED_PATHS = [
  '/usr/sbin/grub-probe',
  '/usr/sbin/dkms',
  '/etc/kernel/postinst.d/zz-update-grub',
  '/etc/kernel/postinst.d/dkms',
] as const;

async function chrootRun(
  targetPath: string,
  cmd: string,
  args: readonly string[],
  opts: { timeout_ms?: number; stdin?: string } = {},
): Promise<void> {
  const r = await run('chroot', [targetPath, cmd, ...args], {
    timeout_ms: opts.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    stdin: opts.stdin,
  });
  if (r.exit_code !== 0) {
    throw new Error(`chroot ${targetPath} ${cmd} ${args.join(' ')} failed (exit=${r.exit_code}): ${r.stderr.trim()}`);
  }
}

async function isDiverted(targetPath: string, path: string): Promise<boolean> {
  const r = await run('chroot', [targetPath, 'dpkg-divert', '--list', path], {
    timeout_ms: DEFAULT_TIMEOUT_MS,
    quiet: true,
  });
  return r.exit_code === 0 && r.stdout.trim().length > 0;
}

async function undoCloudImageDiversions(targetPath: string): Promise<void> {
  for (const p of CLOUD_IMAGE_DIVERTED_PATHS) {
    if (!(await isDiverted(targetPath, p))) continue;
    await chrootRun(targetPath, 'rm', ['-f', p]);
    await chrootRun(targetPath, 'dpkg-divert', ['--rename', '--remove', p]);
  }
}

const GRUB_LINUX_ROOT_RE = /^[ \t]*linux[ \t].*[ \t]root=[^ \t]+/m;

async function assertGrubCfgBootable(targetPath: string): Promise<void> {
  const r = await run('chroot', [targetPath, 'cat', '/boot/grub/grub.cfg'], {
    timeout_ms: DEFAULT_TIMEOUT_MS,
    quiet: true,
  });
  if (r.exit_code !== 0) {
    throw new Error(`cannot read /boot/grub/grub.cfg (exit=${r.exit_code}): ${r.stderr.trim()}`);
  }
  if (!GRUB_LINUX_ROOT_RE.test(r.stdout)) {
    throw new Error(
      'update-grub produced /boot/grub/grub.cfg with empty root= — ' +
        'the deployed system would fail to boot. Likely cause: ' +
        '/usr/sbin/grub-probe is diverted to /bin/true in the target ' +
        'rootfs. Check `dpkg-divert --list /usr/sbin/grub-probe` and ' +
        'the layer that shipped the divert.',
    );
  }
}

async function assertEfiBinaryWritten(targetPath: string, distro: string, grubEfi: string): Promise<void> {
  const rel = `boot/efi/EFI/${distro}/${grubEfi}`;
  try {
    await access(join(targetPath, rel));
  } catch {
    throw new Error(
      `grub-install exited 0 but produced no /${rel} — the deployed system has no working ` +
        `EFI bootloader and would netboot-loop. Likely cause: grub-install skipped writing the ` +
        `core image (grub-probe diverted, ESP not FAT-mounted at /boot/efi, or --target/efi-directory mismatch).`,
    );
  }
}

async function writeTarget(targetPath: string, relPath: string, content: string, mode: number): Promise<void> {
  const full = join(targetPath, relPath);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, content, { mode });
}

async function installGrubUefi(
  targetPath: string,
  arch: Architecture,
  distro: string,
  grubDefaults: string,
  fallbackCfg: string | undefined,
  purgeTtys: boolean,
): Promise<string[]> {
  const { efiTarget, efiFallback, grubEfi } = ARCH_TARGETS[arch];

  await chrootRun(targetPath, 'debconf-set-selections', [], {
    stdin: `grub-efi-${arch} grub2/update_nvram boolean false\n`,
  });

  await chrootRun(targetPath, 'grub-install', [
    `--target=${efiTarget}`,
    '--efi-directory=/boot/efi',
    `--bootloader-id=${distro}`,
    '--no-nvram',
    '--recheck',
  ]);

  if (fallbackCfg !== undefined) {
    const efiBootDir = join(targetPath, 'boot/efi/EFI/BOOT');
    await mkdir(efiBootDir, { recursive: true });

    const scratchDir = await mkdtemp(join(tmpdir(), 'grub-fallback-'));
    const scratchCfg = join(scratchDir, 'grub-fallback.cfg');
    await writeFile(scratchCfg, fallbackCfg, { mode: 0o644 });
    try {
      const fallbackModules =
        'part_gpt fat ext2 xfs lvm mdraid09 mdraid1x chain search search_fs_file configfile normal echo test sleep';
      const mkstandaloneResult = await run(
        'grub-mkstandalone',
        [
          '-O',
          efiTarget,
          '--modules',
          fallbackModules,
          '-o',
          join(efiBootDir, efiFallback),
          `boot/grub/grub.cfg=${scratchCfg}`,
        ],
        { timeout_ms: DEFAULT_TIMEOUT_MS },
      );
      if (mkstandaloneResult.exit_code !== 0) {
        throw new Error(
          `grub-mkstandalone failed (exit=${mkstandaloneResult.exit_code}): ${mkstandaloneResult.stderr.trim()}`,
        );
      }
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  }

  await writeTarget(targetPath, 'etc/default/grub', grubDefaults, 0o644);

  if (purgeTtys) {
    const r = await run(
      'chroot',
      [
        targetPath,
        'sed',
        '-i',
        '-E',
        's/ console=ttyS[0-9]+(,[^ ]*)?//g',
        '/etc/default/grub.d/50-cloudimg-settings.cfg',
      ],
      { timeout_ms: DEFAULT_TIMEOUT_MS },
    );
    if (r.exit_code !== 0) {
      logger.warn('deploy.installGrub: purge_ttys sed failed (continuing)', {
        exit_code: r.exit_code,
        stderr: r.stderr.trim(),
      });
    }
  }

  await undoCloudImageDiversions(targetPath);
  await chrootRun(targetPath, 'update-grub', []);
  await assertGrubCfgBootable(targetPath);

  await chrootRun(targetPath, 'grub-install', [
    `--target=${efiTarget}`,
    '--efi-directory=/boot/efi',
    `--bootloader-id=${distro}`,
    '--no-nvram',
    '--recheck',
  ]);

  await assertEfiBinaryWritten(targetPath, distro, grubEfi);

  return [efiTarget];
}

async function installGrubLegacy(
  targetPath: string,
  grubDisks: readonly string[],
  grubDefaults: string,
  purgeTtys: boolean,
): Promise<string[]> {
  const installedTargets: string[] = [];

  for (const disk of grubDisks) {
    await chrootRun(targetPath, 'grub-install', ['--target=i386-pc', '--boot-directory=/boot', '--recheck', disk]);
    installedTargets.push(`i386-pc:${disk}`);
  }

  await writeTarget(targetPath, 'etc/default/grub', grubDefaults, 0o644);

  if (purgeTtys) {
    const r = await run(
      'chroot',
      [
        targetPath,
        'sed',
        '-i',
        '-E',
        's/ console=ttyS[0-9]+(,[^ ]*)?//g',
        '/etc/default/grub.d/50-cloudimg-settings.cfg',
      ],
      { timeout_ms: DEFAULT_TIMEOUT_MS },
    );
    if (r.exit_code !== 0) {
      logger.warn('deploy.installGrub (legacy): purge_ttys sed failed (continuing)', {
        exit_code: r.exit_code,
        stderr: r.stderr.trim(),
      });
    }
  }

  await undoCloudImageDiversions(targetPath);
  await chrootRun(targetPath, 'update-grub', []);
  await assertGrubCfgBootable(targetPath);

  return installedTargets;
}

export function registerGrubInstaller(): void {
  registerOperation('deploy.installGrub', async (input) => {
    const { target_path, arch, uefi, distro, grub_disks, grub_defaults, grub_fallback_cfg, purge_ttys } = input;
    assertTargetPathSafe(target_path);

    const installedTargets = uefi
      ? await installGrubUefi(target_path, arch, distro, grub_defaults, grub_fallback_cfg, purge_ttys)
      : await installGrubLegacy(target_path, grub_disks, grub_defaults, purge_ttys);

    return { installed_targets: installedTargets };
  });
}
