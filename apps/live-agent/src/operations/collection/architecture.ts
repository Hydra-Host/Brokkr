import { registerOperation } from '../../dispatch/registry';
import { run } from '../../exec';

export function registerArchitectureCollector(): void {
  registerOperation('collection.architecture', async () => {
    const { stdout, exit_code, stderr } = await run('uname', ['-m'], { timeout_ms: 10_000 });
    if (exit_code !== 0) {
      throw new Error(`uname -m failed (exit=${exit_code}): ${stderr.trim()}`);
    }
    return { architecture: { machine: stdout.trim() } };
  });
}
