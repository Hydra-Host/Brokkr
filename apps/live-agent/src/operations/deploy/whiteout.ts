import { getErrorMessage } from '../../errors';

import { lstat, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { registerOperation } from '../../dispatch/registry';
import { makeLogger } from '../../logger';
import { assertTargetPathSafe } from './targetPath';
const logger = makeLogger('deploy');

export function registerWhiteoutRemover(): void {
  registerOperation('deploy.removeWhiteouts', async (input) => {
    const { target_path } = input;
    assertTargetPathSafe(target_path);

    let removed = 0;
    let errors = 0;

    let entries;
    try {
      entries = await readdir(target_path, {
        recursive: true,
        withFileTypes: true,
      });
    } catch (error) {
      logger.warn('deploy.removeWhiteouts: readdir failed (continuing)', {
        target_path,
        err: getErrorMessage(error),
      });
      return { removed: 0 };
    }

    for (const entry of entries) {
      if (!entry.isCharacterDevice()) continue;

      const full = join(entry.parentPath, entry.name);
      try {
        const st = await lstat(full);
        if (st.rdev === 0) {
          await unlink(full);
          removed += 1;
        }
      } catch (error) {
        errors += 1;
        logger.warn('deploy.removeWhiteouts: per-file failure (continuing)', {
          path: full,
          err: getErrorMessage(error),
        });
      }
    }

    void errors;
    return { removed };
  });
}
