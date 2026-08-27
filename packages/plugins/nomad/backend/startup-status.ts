import type { NomadStartupStatus, NomadStartupTaskStatus } from '../schemas';
import type { NomadAllocStub, NomadTaskEvent, NomadTaskState } from './types/nomad-api';

export const DEFAULT_SOFT_TIMEOUT_MS = 60_000;
export const DEFAULT_HARD_TIMEOUT_MS = 600_000;

export interface EvaluateNomadStartupParams {
  allocations: NomadAllocStub[];
  elapsedMs: number;
  softTimeoutMs: number;
  hardTimeoutMs: number;
  /** When true, all-running is not terminal; wait for complete. */
  oneShot?: boolean;
  /** Display-only expected task names per group (seeds pending rows). */
  expectedTasksByGroup?: Record<string, string[]>;
  /** Job Status from the spec read; null disables the no-placement check. */
  jobStatus?: string | null;
  /** Authoritative Version; null = spec read failed (withhold terminal success). */
  jobVersion?: number | null;
}

// Event Types that indicate failure (vs lifecycle noise).
const FAILURE_EVENT_TYPES = new Set([
  'Terminated',
  'Not Restarting',
  'Driver Failure',
  'Setup Failure',
  'Failed Artifact Download',
  'Failed Validating Task',
  'Killing',
  'Killed',
  'Sibling Task Failed',
  'Leader Task Dead',
]);

// Clean dead (Failed:false) is a completed lifecycle task, not a failure.
const taskIsFailing = (state: NomadTaskState): boolean => state.Failed === true;

// Non-empty NextAllocation means this alloc was superseded by a replacement.
const isSuperseded = (alloc: NomadAllocStub): boolean =>
  typeof alloc.NextAllocation === 'string' && alloc.NextAllocation.length > 0;

// Keep only the authoritative jobVersion's allocs; else max-version-in-list.
const latestVersionOnly = (allocations: NomadAllocStub[], jobVersion?: number | null): NomadAllocStub[] => {
  if (typeof jobVersion === 'number') {
    return allocations.filter((a) => a.JobVersion === undefined || a.JobVersion === jobVersion);
  }
  const versions = allocations.map((a) => a.JobVersion).filter((v): v is number => v !== undefined);
  if (versions.length === 0) return allocations;
  const maxVersion = Math.max(...versions);
  return allocations.filter((a) => a.JobVersion === undefined || a.JobVersion >= maxVersion);
};

// Latest DisplayMessage by Time in pool (or all messaged events if pool empty).
const latestMessage = (withMessage: NomadTaskEvent[], pool: NomadTaskEvent[]): string | undefined => {
  const chosen = pool.length > 0 ? pool : withMessage;
  if (chosen.length === 0) return undefined;
  const best = chosen.reduce((acc, e) => ((e.Time ?? 0) >= (acc.Time ?? 0) ? e : acc));
  return best.DisplayMessage;
};

// Prefer latest Terminated message, else latest failure-typed, else latest message.
const mostRecentFailureMessage = (events: NomadTaskEvent[] | undefined): string | undefined => {
  if (!events || events.length === 0) return undefined;
  const withMessage = events.filter((e) => Boolean(e.DisplayMessage));
  if (withMessage.length === 0) return undefined;
  const terminated = withMessage.filter((e) => e.Type === 'Terminated');
  if (terminated.length > 0) return latestMessage(withMessage, terminated);
  return latestMessage(
    withMessage,
    withMessage.filter((e) => FAILURE_EVENT_TYPES.has(e.Type)),
  );
};

// Latest event DisplayMessage of any type; null if none.
const mostRecentEventMessage = (events: NomadTaskEvent[] | undefined): string | null => {
  if (!events || events.length === 0) return null;
  return (
    latestMessage(
      events.filter((e) => Boolean(e.DisplayMessage)),
      [],
    ) ?? null
  );
};

// One entry per task across every live alloc (same name on two allocs = two rows).
const buildTaskStatuses = (
  allocations: NomadAllocStub[],
  expectedTasksByGroup: Record<string, string[]>,
): NomadStartupTaskStatus[] => {
  const statuses: NomadStartupTaskStatus[] = [];
  for (const alloc of allocations) {
    const taskStates = alloc.TaskStates ?? {};
    for (const [task, state] of Object.entries(taskStates)) {
      const failed = taskIsFailing(state);
      // Pending tasks in a retry loop end on "Restarting in Ns" events; surface
      // the causal failure (e.g. image pull denied) instead of the countdown.
      const detail =
        state.State === 'pending'
          ? (mostRecentFailureMessage(state.Events) ?? mostRecentEventMessage(state.Events))
          : mostRecentEventMessage(state.Events);
      statuses.push({
        task,
        taskGroup: alloc.TaskGroup ?? '',
        allocId: alloc.ID,
        state: state.State,
        startedAt: state.StartedAt ?? null,
        failed,
        failureReason: failed ? (mostRecentFailureMessage(state.Events) ?? `${task}: ${state.State}`) : null,
        detail,
      });
    }
    // Seed expected tasks as pending when TaskStates has not reported them yet.
    for (const task of expectedTasksByGroup[alloc.TaskGroup ?? ''] ?? []) {
      if (task in taskStates) continue;
      statuses.push({
        task,
        taskGroup: alloc.TaskGroup ?? '',
        allocId: alloc.ID,
        state: 'pending',
        startedAt: null,
        failed: false,
        failureReason: null,
        detail: 'waiting for task to start',
      });
    }
  }
  return statuses;
};

// In-progress note: "N/M tasks running".
const runningCountMessage = (tasks: NomadStartupTaskStatus[]): string => {
  const running = tasks.filter((t) => t.state === 'running').length;
  return `${running}/${tasks.length} tasks running`;
};

const collectFailures = (allocations: NomadAllocStub[], tasks: NomadStartupTaskStatus[]): string[] => {
  const failures = tasks.filter((t) => t.failed).map((t) => t.failureReason ?? `${t.task}: ${t.state}`);
  // Fallback when ClientStatus is failed but no task-level failure surfaced.
  if (failures.length === 0 && allocations.some((a) => a.ClientStatus === 'failed')) {
    failures.push('allocation failed');
  }
  return failures;
};

const hasFailure = (allocations: NomadAllocStub[]): boolean =>
  allocations.some(
    (a) => a.ClientStatus === 'failed' || Object.values(a.TaskStates ?? {}).some((state) => taskIsFailing(state)),
  );

// Up = running, or clean dead (Failed:false) lifecycle completion.
const taskIsUp = (state: NomadTaskState): boolean =>
  state.State === 'running' || (state.State === 'dead' && state.Failed !== true);

// All allocs running with ≥1 running task and every task up (running or clean dead).
const isAllRunning = (allocations: NomadAllocStub[]): boolean => {
  if (allocations.length === 0) return false;
  return allocations.every((a) => {
    if (a.ClientStatus !== 'running') return false;
    const states = Object.values(a.TaskStates ?? {});
    return states.length > 0 && states.some((state) => state.State === 'running') && states.every(taskIsUp);
  });
};

// One-shot success: every alloc ClientStatus complete with clean-dead tasks.
const isAllComplete = (allocations: NomadAllocStub[]): boolean => {
  if (allocations.length === 0) return false;
  return allocations.every((a) => {
    if (a.ClientStatus !== 'complete') return false;
    const states = Object.values(a.TaskStates ?? {});
    return states.length > 0 && states.every((state) => state.State === 'dead' && state.Failed !== true);
  });
};

/** Pure startup verdict from an alloc snapshot + elapsed timing (no I/O). */
export function evaluateNomadStartup({
  allocations,
  elapsedMs,
  softTimeoutMs,
  hardTimeoutMs,
  oneShot = false,
  expectedTasksByGroup = {},
  jobStatus = null,
  jobVersion,
}: EvaluateNomadStartupParams): NomadStartupStatus {
  // Spec read failed → withhold terminal success (alloc list may be a prior run).
  const versionUnverified = jobVersion === null;
  // Drop older job versions and superseded allocs before judging.
  const liveAllocations = latestVersionOnly(allocations, jobVersion).filter((a) => !isSuperseded(a));
  const tasks = buildTaskStatuses(liveAllocations, expectedTasksByGroup);
  // Soft timeout flag reflects elapsed timing even on terminal verdicts.
  const softTimeoutReached = elapsedMs >= softTimeoutMs;

  if (hasFailure(liveAllocations)) {
    // Stay non-done while siblings settle; hard timeout caps polling.
    const stillSettling = liveAllocations.some((a) => a.ClientStatus === 'running' || a.ClientStatus === 'pending');
    const done = !stillSettling || elapsedMs >= hardTimeoutMs;
    return {
      stage: 'failed',
      done,
      ok: false,
      tasks,
      failures: collectFailures(liveAllocations, tasks),
      softTimeoutReached,
      message: done ? null : 'failure detected; waiting for remaining tasks to settle',
    };
  }

  if (isAllRunning(liveAllocations)) {
    // Terminal running success only with a trusted jobVersion.
    if (!oneShot && !versionUnverified) {
      return { stage: 'running', done: true, ok: true, tasks, failures: [], softTimeoutReached, message: null };
    }
    // One-shot mid-run or unverified version: keep polling until hard timeout.
    if (elapsedMs < hardTimeoutMs) {
      return {
        stage: 'running',
        done: false,
        ok: null,
        tasks,
        failures: [],
        softTimeoutReached,
        message: oneShot ? runningCountMessage(tasks) : 'running; awaiting job-version confirmation',
      };
    }
  }

  // One-shot terminal success when every alloc is complete.
  if (isAllComplete(liveAllocations)) {
    if (!versionUnverified) {
      return { stage: 'completed', done: true, ok: true, tasks, failures: [], softTimeoutReached, message: null };
    }
    // Unverified version: do not freeze a possibly-stale complete success.
    if (elapsedMs < hardTimeoutMs) {
      return {
        stage: 'starting',
        done: false,
        ok: null,
        tasks,
        failures: [],
        softTimeoutReached,
        message: 'allocations complete; awaiting job-version confirmation',
      };
    }
  }

  // Dead job with no live allocs: scheduling finished empty (no retry).
  if (liveAllocations.length === 0 && jobStatus === 'dead') {
    return {
      stage: 'failed',
      done: true,
      ok: false,
      tasks,
      failures: [
        'job finished without placing any allocations — the target node may have been ineligible at submit; redeploy to retry',
      ],
      softTimeoutReached,
      message: null,
    };
  }

  if (elapsedMs >= hardTimeoutMs) {
    return {
      stage: 'timed_out',
      done: true,
      ok: false,
      tasks,
      failures: [],
      softTimeoutReached,
      message: 'job startup timed out',
    };
  }

  // In-progress staging: placement-oriented until tasks report.
  let stage: NomadStartupStatus['stage'];
  let message: string;
  if (liveAllocations.length === 0) {
    // Nothing placed yet (or all superseded).
    stage = 'scheduling';
    message = 'waiting for allocation placement';
  } else if (tasks.length === 0) {
    // Allocs exist but TaskStates empty — trust ClientStatus.
    if (liveAllocations.some((a) => a.ClientStatus === 'running')) {
      stage = 'starting';
      message = 'allocation running, waiting for task status';
    } else {
      stage = 'placed';
      message = 'allocation placed, waiting for tasks to start';
    }
  } else {
    // Tasks reported but not all running.
    stage = 'starting';
    message = runningCountMessage(tasks);
  }
  return { stage, done: false, ok: null, tasks, failures: [], softTimeoutReached, message };
}
