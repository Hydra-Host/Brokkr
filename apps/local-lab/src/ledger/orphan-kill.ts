import type { Logger } from '@nestjs/common';

import { getErrorMessage } from '@repo/utils';
import type { RunSection } from '../contract';

export const ORPHAN_KILL_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// StackRestartService detaches a `stack-down/wipe; stack-up` child, which is MEANT to outlive this
// process and is what restarts it — signalling that pid on the next boot would abort our own restart.
export const KILLABLE_SECTIONS: ReadonlySet<RunSection> = new Set<RunSection>(['test', 'fleet']);

export interface OrphanRun {
  runId: string;
  section: RunSection;
  opId: string;
  pid: number | null;
  startedAt: number;
}

function describe(run: OrphanRun): string {
  return `run ${run.runId} (${run.section}/${run.opId})`;
}

/** Signals an orphaned run's process group, and only ever for a section whose children are safe to kill. */
export function killOrphanRun(run: OrphanRun, log: Logger, now: number = Date.now()): boolean {
  if (!KILLABLE_SECTIONS.has(run.section)) return false;
  const pid = run.pid;
  if (pid === null) return false;
  if (pid <= 0) {
    log.warn(`orphan ${describe(run)}: refusing to signal non-positive pid ${pid}`);
    return false;
  }
  // a pid from days ago has certainly been recycled onto an unrelated process
  if (now - run.startedAt >= ORPHAN_KILL_MAX_AGE_MS) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch (error) {
    // our own children all lead a group (spawn detaches, spawnPty opens a session), so a pid that leads
    // none is a recycled pid — signalling it bare would hit a stranger
    log.warn(`orphan ${describe(run)}: process-group kill of pid ${pid} failed: ${getErrorMessage(error)}`);
    return false;
  }
  log.warn(`orphan ${describe(run)}: sent SIGTERM to pid ${pid}`);
  return true;
}
