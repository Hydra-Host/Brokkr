import { registerOperation } from '../../dispatch/registry';
import { run } from '../../exec';

export function registerGptClearer(): void {
  registerOperation('storage.clearGpt', async ({ disk_name }) => {
    const dev = `/dev/${disk_name}`;

    const sgdisk = await run('sgdisk', ['-Z', dev], { timeout_ms: 30_000 });
    if (sgdisk.exit_code !== 0) {
      throw new Error(`sgdisk -Z ${dev} failed (exit=${sgdisk.exit_code}): ${sgdisk.stderr.trim()}`);
    }

    const wipefs = await run('wipefs', ['--all', '--force', dev], { timeout_ms: 30_000 });
    if (wipefs.exit_code !== 0) {
      throw new Error(`wipefs ${dev} failed (exit=${wipefs.exit_code}): ${wipefs.stderr.trim()}`);
    }

    return { success: true };
  });
}
