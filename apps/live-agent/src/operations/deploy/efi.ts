import { rm as fsRm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { registerOperation } from '../../dispatch/registry';
import { run } from '../../exec';
import { assertTargetPathSafe } from './targetPath';

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export function registerEfiFinalizer(): void {
  registerOperation('deploy.finalizeEfi', async (input) => {
    const { target_path, uefi } = input;
    assertTargetPathSafe(target_path);

    if (!uefi) {
      return { skipped: true, cleaned: [] };
    }

    const updateGrub = await run('chroot', [target_path, 'update-grub'], {
      timeout_ms: DEFAULT_TIMEOUT_MS,
    });
    if (updateGrub.exit_code !== 0) {
      throw new Error(`update-grub failed (exit=${updateGrub.exit_code}): ${updateGrub.stderr.trim()}`);
    }

    const bootDir = join(target_path, 'boot');
    let entries;
    try {
      entries = await readdir(bootDir, { withFileTypes: true });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return { skipped: false, cleaned: [] };
      }
      throw error;
    }

    const candidates = entries
      .filter((e) => e.isDirectory() && e.name.startsWith('efi') && e.name !== 'efi')
      .map((e) => e.name);

    const cleaned: string[] = [];
    for (const dir of candidates) {
      if (!/^efi\d+$/.test(dir)) continue;
      const fullPath = join(target_path, 'boot', dir);

      const cp = await run('chroot', [target_path, 'sh', '-c', `cp -a /boot/efi/* /boot/${dir}/`], {
        timeout_ms: DEFAULT_TIMEOUT_MS,
      });
      if (cp.exit_code !== 0) {
        throw new Error(`cp /boot/efi → /boot/${dir} failed (exit=${cp.exit_code}): ${cp.stderr.trim()}`);
      }

      const umount = await run('umount', [fullPath], { timeout_ms: 30_000 });
      if (umount.exit_code !== 0) {
        throw new Error(`umount ${fullPath} failed (exit=${umount.exit_code}): ${umount.stderr.trim()}`);
      }

      await fsRm(fullPath, { recursive: true, force: true });
      cleaned.push(fullPath);
    }

    return { skipped: false, cleaned };
  });
}
