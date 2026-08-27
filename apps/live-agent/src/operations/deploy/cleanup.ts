import { rm as fsRm, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { registerOperation } from '../../dispatch/registry';
import { getErrorMessage } from '../../errors';
import { run } from '../../exec';
import { makeLogger } from '../../logger';
import { assertTargetPathSafe } from './target-path';
const logger = makeLogger('deploy');

const FAST_TIMEOUT_MS = 30_000;
const SYNC_TIMEOUT_MS = 5 * 60_000;

async function bestEffort(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    logger.warn('deploy.powerCycleCleanup: step failed (continuing)', {
      label,
      err: getErrorMessage(error),
    });
  }
}

async function removeMatchingChildren(root: string, predicate: (name: string) => boolean): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!predicate(entry.name)) continue;
    const full = join(root, entry.name);
    await fsRm(full, { recursive: true, force: true });
  }
}

async function findEfiMountsUnder(targetPath: string): Promise<string[]> {
  const content = await readFile('/proc/mounts', 'utf-8');
  const matches: string[] = [];
  for (const line of content.split('\n')) {
    const parts = line.split(' ');
    if (parts.length < 2) continue;
    const mp = parts[1];
    if (!mp) continue;
    if (mp.startsWith(targetPath) && mp.includes('/boot/efi')) {
      matches.push(mp);
    }
  }
  return matches;
}

export function registerPowerCycleCleaner(): void {
  registerOperation('deploy.powerCycleCleanup', async (input) => {
    const { target_path } = input;
    assertTargetPathSafe(target_path);

    await bestEffort('remove merge markers', async () => {
      await removeMatchingChildren(target_path, (name) => name.endsWith('-is-merged'));
    });

    await bestEffort('rm run/netplan', async () => {
      await fsRm(join(target_path, 'run', 'netplan'), { recursive: true, force: true });
    });
    await bestEffort('rm var/run/netplan', async () => {
      await fsRm(join(target_path, 'var', 'run', 'netplan'), { recursive: true, force: true });
    });

    await bestEffort('drop ssh host keys', async () => {
      await removeMatchingChildren(join(target_path, 'etc', 'ssh'), (name) => /^ssh_host_.*_key(?:\.pub)?$/.test(name));
    });
    await bestEffort('truncate machine-id', () =>
      run('truncate', ['-s', '0', join(target_path, 'etc', 'machine-id')], { timeout_ms: FAST_TIMEOUT_MS }),
    );
    await bestEffort('drop systemd random-seed', async () => {
      await fsRm(join(target_path, 'var', 'lib', 'systemd', 'random-seed'), { force: true });
    });
    await bestEffort('drop cloud-init instance state', async () => {
      await fsRm(join(target_path, 'var', 'lib', 'cloud', 'instance'), { recursive: true, force: true });
      await fsRm(join(target_path, 'var', 'lib', 'cloud', 'instances'), { recursive: true, force: true });
    });
    await bestEffort('drop cloud-init logs', async () => {
      await fsRm(join(target_path, 'var', 'log', 'cloud-init.log'), { force: true });
      await fsRm(join(target_path, 'var', 'log', 'cloud-init-output.log'), { force: true });
    });

    await bestEffort('sync', () => run('sync', [], { timeout_ms: SYNC_TIMEOUT_MS }));
    await bestEffort('udevadm settle', () => run('udevadm', ['settle'], { timeout_ms: FAST_TIMEOUT_MS }));

    const numberedEfiPattern = /^efi\d+$/;
    await bestEffort('remove numbered EFI dirs', async () => {
      await removeMatchingChildren(join(target_path, 'boot'), (name) => numberedEfiPattern.test(name));
    });

    await bestEffort('xfs_freeze -f', () => run('xfs_freeze', ['-f', target_path], { timeout_ms: FAST_TIMEOUT_MS }));
    await bestEffort('xfs_freeze -u', () => run('xfs_freeze', ['-u', target_path], { timeout_ms: FAST_TIMEOUT_MS }));

    await bestEffort('chroot sync', () => run('chroot', [target_path, 'sync'], { timeout_ms: SYNC_TIMEOUT_MS }));

    await bestEffort('unmount EFI mounts', async () => {
      const mounts = await findEfiMountsUnder(target_path);
      for (const mp of mounts) {
        await bestEffort(`umount ${mp}`, () => run('umount', [mp], { timeout_ms: FAST_TIMEOUT_MS }));
      }
    });

    await sleep(5_000);

    return { success: true };
  });
}
