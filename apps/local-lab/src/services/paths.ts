import { join } from 'node:path';

/** The `devenv` invocation cwd: devenv.nix sits at the repo root two levels above apps/local-sim —
 *  `devenv/` next to it holds only the modules and has no devenv.nix to eval. */
export function devenvRoot(): string {
  if (process.env.DEVENV_ROOT) return process.env.DEVENV_ROOT;
  const repoRoot = process.env.LOCAL_BROKKR_ROOT || join(process.cwd(), '..', 'local-sim');
  return join(repoRoot, '..', '..');
}
