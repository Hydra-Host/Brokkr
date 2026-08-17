import { readFile, rm, writeFile } from 'node:fs/promises';
import { registerOperation } from '../../dispatch/registry';
import { run } from '../../exec';
import { assertTargetPathSafe } from '../deploy/targetPath';

const STORAGE_CONFIG_PATH = '/tmp/storage-config.yaml';
const FSTAB_PATH = '/tmp/fstab';
const WORKING_DIR = '/tmp/curtin-work';

const FSTAB_HEADER = `# /etc/fstab: static file system information.
#
# Use 'blkid' to print the universally unique identifier for a
# device; this may be used with UUID= as a more robust way to name devices
# that works even if disks are added and removed. See fstab(5).
#
# <file system> <mount point>   <type>  <options>       <dump>  <pass>
`;

const CURTIN_TIMEOUT_MS = 30 * 60 * 1000;

export function registerCurtinApplier(): void {
  registerOperation('storage.applyStorageLayout', async ({ curtin_yaml, target_path }) => {
    assertTargetPathSafe(target_path);
    // curtin APPENDS to $OUTPUT_FSTAB rather than truncating — without cleanup, saga retries without a reboot accumulate stale entries.
    await rm(FSTAB_PATH, { force: true });
    await rm('/tmp/crypttab', { force: true });
    await rm(STORAGE_CONFIG_PATH, { force: true });

    await writeFile(STORAGE_CONFIG_PATH, curtin_yaml, 'utf8');

    const curtinEnv: NodeJS.ProcessEnv = {
      ...process.env,
      WORKING_DIR,
      CONFIG: STORAGE_CONFIG_PATH,
      TARGET_MOUNT_POINT: target_path,
      OUTPUT_FSTAB: FSTAB_PATH,
      OUTPUT_INTERFACES: '/dev/null',
      OUTPUT_NETWORK_STATE: '/dev/null',
      OUTPUT_NETWORK_CONFIG: '/dev/null',
    };

    const result = await run('curtin', ['-v', 'block-meta', 'custom'], {
      env: curtinEnv,
      timeout_ms: CURTIN_TIMEOUT_MS,
    });

    if (result.exit_code !== 0) {
      return {
        fstab_content: '',
        success: false,
        error: `curtin block-meta failed (exit=${result.exit_code}): ${result.stderr.trim() || result.stdout.trim()}`,
      };
    }

    let fstabBody = '';
    try {
      fstabBody = await readFile(FSTAB_PATH, 'utf8');
    } catch {
      fstabBody = '';
    }

    return {
      fstab_content: fstabBody ? `${FSTAB_HEADER}${fstabBody}` : '',
      success: true,
    };
  });
}
