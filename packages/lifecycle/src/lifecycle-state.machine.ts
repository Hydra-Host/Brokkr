import { JobType, LifecycleJobPhase } from '@repo/database';

export const ALLOWED_TRANSITIONS: Record<LifecycleJobPhase, readonly LifecycleJobPhase[]> = {
  [LifecycleJobPhase.REQUESTED]: [
    LifecycleJobPhase.AUTHORIZING,
    LifecycleJobPhase.SCHEDULED,
    LifecycleJobPhase.ABORTED,
  ],
  [LifecycleJobPhase.SCHEDULED]: [LifecycleJobPhase.AUTHORIZING, LifecycleJobPhase.ABORTED],
  // AUTHORIZING/DISPATCHED → SCHEDULED are the sole backward edges — retry-only for the interruptible grace timer.
  [LifecycleJobPhase.AUTHORIZING]: [
    LifecycleJobPhase.DISPATCHED,
    LifecycleJobPhase.SCHEDULED,
    LifecycleJobPhase.DEFERRED,
    LifecycleJobPhase.ABORTED,
  ],
  [LifecycleJobPhase.DEFERRED]: [LifecycleJobPhase.AUTHORIZING, LifecycleJobPhase.ABORTED],
  [LifecycleJobPhase.DISPATCHED]: [LifecycleJobPhase.RUNNING, LifecycleJobPhase.SCHEDULED, LifecycleJobPhase.FAILED],
  [LifecycleJobPhase.RUNNING]: [
    LifecycleJobPhase.AWAITING_PHONE_HOME,
    LifecycleJobPhase.COMPLETED,
    LifecycleJobPhase.FAILED,
  ],
  [LifecycleJobPhase.AWAITING_PHONE_HOME]: [LifecycleJobPhase.COMPLETED, LifecycleJobPhase.FAILED],
  [LifecycleJobPhase.COMPLETED]: [],
  [LifecycleJobPhase.FAILED]: [],
  [LifecycleJobPhase.ABORTED]: [],
};

export class IllegalPhaseTransitionError extends Error {
  constructor(
    public readonly from: LifecycleJobPhase | undefined,
    public readonly to: LifecycleJobPhase,
  ) {
    super(`Illegal lifecycle phase transition: ${from ?? '<unset>'} → ${to}`);
    this.name = 'IllegalPhaseTransitionError';
  }
}

export function canTransition(from: LifecycleJobPhase | undefined, to: LifecycleJobPhase): boolean {
  if (from === undefined) return false;
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: LifecycleJobPhase | undefined, to: LifecycleJobPhase): void {
  if (!canTransition(from, to)) {
    throw new IllegalPhaseTransitionError(from, to);
  }
}

export type BridgeEventType = 'stage_changed' | 'job_failed' | 'job_completed';

const AWAITS_PHONE_HOME: ReadonlySet<JobType> = new Set([JobType.Provision, JobType.Reprovision]);

const PRE_RUNNING: ReadonlySet<LifecycleJobPhase> = new Set([
  LifecycleJobPhase.SCHEDULED,
  LifecycleJobPhase.AUTHORIZING,
  LifecycleJobPhase.DISPATCHED,
]);

export function nextPhaseForBridge(
  jobType: JobType,
  current: LifecycleJobPhase,
  eventType: BridgeEventType,
  status: string,
): LifecycleJobPhase | null {
  if (eventType === 'job_failed') return LifecycleJobPhase.FAILED;

  if (eventType === 'job_completed') {
    if (status === 'complete') {
      return AWAITS_PHONE_HOME.has(jobType) ? LifecycleJobPhase.AWAITING_PHONE_HOME : LifecycleJobPhase.COMPLETED;
    }
    return LifecycleJobPhase.FAILED;
  }

  return PRE_RUNNING.has(current) ? LifecycleJobPhase.RUNNING : null;
}
