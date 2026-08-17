import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { registerOperation } from '../../dispatch/registry';
import { run } from '../../exec';
import { makeLogger } from '../../logger';
import { assertTargetPathSafe } from './targetPath';
const logger = makeLogger('deploy');

const UNIT_REL_PATH = 'usr/lib/systemd/system/nvidia-persistenced.service';
const TIMEOUT_MS = 30_000;

export function registerRoceChrootConfigurer(): void {
  registerOperation('deploy.applyRoceChrootConfig', async (input) => {
    const { target_path } = input;
    assertTargetPathSafe(target_path);

    const unitAbsPath = join(target_path, UNIT_REL_PATH);
    try {
      await stat(unitAbsPath);
    } catch {
      return { success: true };
    }

    const r = await run('chroot', [target_path, 'sed', '-i', 's/\\s*--no-persistence-mode//g', `/${UNIT_REL_PATH}`], {
      timeout_ms: TIMEOUT_MS,
    });

    if (r.exit_code !== 0) {
      logger.warn('deploy.applyRoceChrootConfig: sed failed (deployment continues)', {
        exit_code: r.exit_code,
        stderr: r.stderr.trim(),
      });
      return { success: false };
    }
    return { success: true };
  });
}
