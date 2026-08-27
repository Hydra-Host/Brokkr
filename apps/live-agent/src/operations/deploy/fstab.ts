import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { registerOperation } from '../../dispatch/registry';
import { assertTargetPathSafe } from './target-path';

async function writeTextFile(targetPath: string, relativePath: string, content: string, mode: number): Promise<void> {
  const full = join(targetPath, relativePath);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content, { mode });
}

export function registerFstabWriters(): void {
  registerOperation('deploy.writeFstab', async (input) => {
    const { target_path, content } = input;
    assertTargetPathSafe(target_path);
    await writeTextFile(target_path, 'etc/fstab', content, 0o644);
    return { success: true };
  });

  registerOperation('deploy.writeCrypttab', async (input) => {
    const { target_path, content } = input;
    assertTargetPathSafe(target_path);
    if (!content) {
      return { success: true };
    }
    await writeTextFile(target_path, 'etc/crypttab', content, 0o644);
    return { success: true };
  });
}
