import { registerOperation } from '../../dispatch/registry';
import { run } from '../../exec';
import { makeLogger } from '../../logger';
import { assertTargetPathSafe } from './target-path';
const logger = makeLogger('deploy');

type MountSpec = {
  point: string;
  cmd: string;
  args: readonly string[];
};

const MOUNT_SPECS: readonly MountSpec[] = [
  { point: 'dev', cmd: 'mount', args: ['--bind', '/dev'] },
  { point: 'proc', cmd: 'mount', args: ['-t', 'proc', 'proc'] },
  { point: 'sys', cmd: 'mount', args: ['-t', 'sysfs', 'sys'] },
  { point: 'run', cmd: 'mount', args: ['--bind', '/run'] },
  { point: 'dev/pts', cmd: 'mount', args: ['--bind', '/dev/pts'] },
  {
    point: 'sys/firmware/efi/efivars',
    cmd: 'mount',
    args: ['--bind', '/sys/firmware/efi/efivars'],
  },
];

const MOUNT_TIMEOUT_MS = 30_000;
const UMOUNT_TIMEOUT_MS = 30_000;

async function isMounted(path: string): Promise<boolean> {
  const r = await run('mountpoint', ['-q', path], { timeout_ms: 5_000, quiet_nonzero: true });
  return r.exit_code === 0;
}

async function mkdirP(path: string): Promise<void> {
  const r = await run('mkdir', ['-p', path], { timeout_ms: 5_000 });
  if (r.exit_code !== 0) {
    throw new Error(`mkdir -p ${path} failed (exit=${r.exit_code}): ${r.stderr.trim()}`);
  }
}

async function attemptUnmount(path: string): Promise<boolean> {
  if (!(await isMounted(path))) return true;
  const r = await run('umount', [path], { timeout_ms: UMOUNT_TIMEOUT_MS });
  if (r.exit_code !== 0) return false;
  return !(await isMounted(path));
}

export function registerChrootOps(): void {
  registerOperation('deploy.mountChroot', async (input) => {
    const { target_path } = input;
    assertTargetPathSafe(target_path);
    const mounted: string[] = [];

    for (const spec of MOUNT_SPECS) {
      const fullPath = `${target_path}/${spec.point}`;
      await mkdirP(fullPath);

      if (await isMounted(fullPath)) {
        mounted.push(fullPath);
        continue;
      }

      const r = await run(spec.cmd, [...spec.args, fullPath], {
        timeout_ms: MOUNT_TIMEOUT_MS,
      });
      if (r.exit_code !== 0) {
        for (const m of [...mounted].reverse()) {
          await attemptUnmount(m);
        }
        throw new Error(`mount ${fullPath} failed (exit=${r.exit_code}): ${r.stderr.trim()}`);
      }

      // --make-private prevents mount propagation from leaking into the chroot.
      const priv = await run('mount', ['--make-private', fullPath], {
        timeout_ms: MOUNT_TIMEOUT_MS,
      });
      if (priv.exit_code !== 0) {
        await attemptUnmount(fullPath);
        for (const m of [...mounted].reverse()) {
          await attemptUnmount(m);
        }
        throw new Error(`mount --make-private ${fullPath} failed (exit=${priv.exit_code}): ${priv.stderr.trim()}`);
      }

      if (!(await isMounted(fullPath))) {
        logger.warn('deploy.mountChroot: mount command succeeded but path is not a mountpoint', {
          path: fullPath,
        });
      }

      mounted.push(fullPath);
    }

    if (mounted.length === 0) {
      throw new Error('no chroot mountpoints were mounted');
    }

    return { mounted_points: mounted };
  });

  registerOperation('deploy.unmountChroot', async (input) => {
    const { target_path } = input;
    assertTargetPathSafe(target_path);

    const unmounted: string[] = [];
    for (const spec of [...MOUNT_SPECS].reverse()) {
      const fullPath = `${target_path}/${spec.point}`;
      if (!(await isMounted(fullPath))) continue;
      if (await attemptUnmount(fullPath)) unmounted.push(fullPath);
    }

    return { unmounted };
  });
}
