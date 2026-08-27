import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { registerOperation } from '../../dispatch/registry';
import { run } from '../../exec';
import { assertTargetPathSafe } from './target-path';

const MDADM_TIMEOUT_MS = 60_000;

export function registerMdadmConfigurer(): void {
  registerOperation('deploy.configureMdadm', async (input) => {
    const { target_path, hostname } = input;
    assertTargetPathSafe(target_path);

    const scan = await run('chroot', [target_path, 'mdadm', '--detail', '--scan'], {
      timeout_ms: MDADM_TIMEOUT_MS,
    });
    if (scan.exit_code !== 0 && scan.stdout.trim() === '') {
      return { configured: false };
    }

    const output = scan.stdout.trim();
    if (output === '') {
      return { configured: false };
    }

    const finalContent = output.replace(/brokkr-discovery/g, hostname) + '\n';

    const mdadmDir = join(target_path, 'etc', 'mdadm');
    await mkdir(mdadmDir, { recursive: true });
    await writeFile(join(mdadmDir, 'mdadm.conf'), finalContent, { mode: 0o644 });

    return { configured: true };
  });
}
