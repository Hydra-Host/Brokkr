import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { assertSafeRunId } from './common/run-id';

// the env var and on-disk dir name are legacy-frozen from the allure era (existing user env + state compat)
const HOME_RESULTS_ROOT = join(homedir(), '.local', 'share', 'local', 'state', 'allure-runs');

export const RESULTS_ROOT = process.env.LOCAL_BROKKR_ALLURE || HOME_RESULTS_ROOT;

// This root ignores LOCAL_STATE, which is what every spec stubs to isolate itself, so the HOME default
// surviving a redirected LOCAL_STATE is how a sweep reaches a developer's real history.
export function resultsRootBelongsToStateDir(stateDir: string): boolean {
  const root = resolve(RESULTS_ROOT);
  // a root that is not the home default was configured explicitly, which is the operator's call;
  // read from the captured root rather than the env, which a spec's unstubAllEnvs would erase
  if (root !== resolve(HOME_RESULTS_ROOT)) return true;
  const owner = resolve(stateDir);
  return root === owner || root.startsWith(`${owner}${sep}`);
}

const RESULTS_SUFFIX = '-results';

export function resultsDir(runId: string): string {
  assertSafeRunId(runId);
  return join(RESULTS_ROOT, `${runId}${RESULTS_SUFFIX}`);
}

export interface ResultsEntry {
  runId: string;
  path: string;
}

/** Every results dir on disk. The names come from the root itself, so each path is inside it by
 *  construction — but the run id derived from one is not necessarily safe. */
export function listResultsDirs(): ResultsEntry[] {
  if (!existsSync(RESULTS_ROOT)) return [];
  return readdirSync(RESULTS_ROOT)
    .filter((entry) => entry.endsWith(RESULTS_SUFFIX))
    .map((entry) => ({ runId: entry.slice(0, -RESULTS_SUFFIX.length), path: join(RESULTS_ROOT, entry) }));
}
