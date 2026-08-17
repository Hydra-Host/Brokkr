import { registerOperation } from '../../dispatch/registry';
import { run } from '../../exec';

export function registerIsVirtualCollector(): void {
  registerOperation('collection.is_virtual', async () => {
    try {
      const { stdout } = await run('systemd-detect-virt', [], { timeout_ms: 5_000 });
      const virt_type = stdout.trim().toLowerCase() || 'none';
      return {
        is_virtual: virt_type !== 'none',
        virt_type,
      };
    } catch {
      return { is_virtual: false, virt_type: 'unknown' };
    }
  });
}
