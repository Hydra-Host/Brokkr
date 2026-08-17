import { existsSync } from 'node:fs';
import { join } from 'node:path';

let cached: string | undefined;

export function engineRoot(): string {
  if (cached !== undefined) return cached;
  const root = process.env.LOCAL_BROKKR_ROOT || join(process.cwd(), '..', 'local-sim');
  const sentinel = join(root, 'scripts', 'local', 'fleet.py');
  if (!existsSync(sentinel)) {
    throw new Error(
      `local-sim engine not found at '${root}' (expected ${sentinel}). ` +
        'Set LOCAL_BROKKR_ROOT to the apps/local-sim directory.',
    );
  }
  cached = root;
  return cached;
}

export function resetEngineRootCache(): void {
  cached = undefined;
}
