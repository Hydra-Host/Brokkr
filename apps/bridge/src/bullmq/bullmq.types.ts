import { UnrecoverableError } from 'bullmq';

export const JOB_NAME = {
  SAGA_RUN: 'saga.run',
  COLLECTION_RUN: 'collection.run',
  DIAGNOSTICS_RUN: 'diagnostics.run',
  TESTING_RUN: 'testing.run',
} as const;

export type JobName = (typeof JOB_NAME)[keyof typeof JOB_NAME];

export const RESULT_JOB_NAME = {
  JOB_RESULT: 'job.result',
  JOB_COMPLETED: 'job.completed',
  DISCOVERY_COMPLETE: 'discovery.complete',
  DEVICE_PHONE_HOME: 'device.phone_home',
  RENDER_REQUEST: 'render.request',
  SECRET_REVEALED: 'secret.revealed',
} as const;

export type ResultJobName = (typeof RESULT_JOB_NAME)[keyof typeof RESULT_JOB_NAME];

export const LOCKLESS_SAGAS: ReadonlySet<string> = new Set([
  'device_health_check',
  'heartbeat',
  'power_status',
  'inventory_collection',
  'benchmarks',
  'secret_reveal',
]);

export const AGENT_HANDOFF_REDELAY_SECONDS = 5.0;
export const DEFERRED_HANDOFF_MAX_AGE_SECONDS = 240;
export const DEFERRED_HANDOFF_MAX_DELAY_SECONDS = 300;

// A cross-bridge / no-local-gRPC-session reschedule is legit only while the agent is
// booting (a couple of minutes). Locally-enqueued jobs (e.g. collection.run behind an
// enrich) are not sealed, so the envelope freshness window never fails them — without a
// separate deadline they reschedule forever when the device never boots brokkr-live.
// After this many seconds of continuous "agent not connected" deferral, fail the job.
export const HANDOFF_ABANDON_DEADLINE_SECONDS = 900;
export const HANDOFF_DEFER_REDIS_KEY_PREFIX = 'handoff-defer';
export const HANDOFF_DEFER_REDIS_TTL_SECONDS = HANDOFF_ABANDON_DEADLINE_SECONDS + 300;
export const LOCK_RENEW_MAX_TRANSIENT_FAILURES = 2;
export const LOCK_RENEW_REDIS_COMMAND_ATTEMPTS = 2;
export const LOCK_RENEW_SAFETY_MARGIN_SECONDS = 1;
export const LOCK_LOST_REDELAY_SECONDS = 90;
export const LOCK_WAIT_HARD_CAP_SECONDS = 240;
export const LOCK_WAIT_REDIS_KEY_PREFIX = 'lockwait';
export const LOCK_WAIT_REDIS_TTL_DEFAULT_SECONDS = 3_600;
export const LOCK_WAIT_REDIS_TTL_BUFFER_SECONDS = 300;
export const LOCK_WAIT_NOTIFY_INTERVALS_SECONDS = [60, 300, 1_800] as const;

export const MAX_COLLECTOR_PAYLOAD_BYTES = 5 * 1024 * 1024;

export const EPHEMERAL_SAGAS: ReadonlySet<string> = new Set(['device_health_check', 'inventory_collection']);

export class PlaintextAfterActivationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlaintextAfterActivationError';
  }
}

export class DeviceLockWaitExceeded extends UnrecoverableError {
  constructor(
    readonly lockKey: string,
    readonly elapsed: number,
    readonly attempts: number,
  ) {
    super(`${lockKey} lock wait exceeded after ${elapsed.toFixed(0)}s (${attempts} attempts)`);
    this.name = 'DeviceLockWaitExceeded';
  }
}

export class BridgeLocalPlanMissing extends UnrecoverableError {
  constructor(
    readonly planId: string,
    readonly sagaName: string,
  ) {
    super(`bridge-local pickup for saga '${sagaName}' found no persisted plan ${planId}`);
    this.name = 'BridgeLocalPlanMissing';
  }
}

export class EnvelopeDeferralBudgetExceeded extends UnrecoverableError {
  constructor(message: string) {
    super(message);
    this.name = 'EnvelopeDeferralBudgetExceeded';
  }
}

export class HandoffAbandoned extends UnrecoverableError {
  constructor(
    readonly elapsedSeconds: number,
    readonly attempts: number,
  ) {
    super(
      `discovery agent never connected — device did not boot brokkr-live ` +
        `(${elapsedSeconds.toFixed(0)}s, ${attempts} deferrals)`,
    );
    this.name = 'HandoffAbandoned';
  }
}

export interface SagaJobData {
  plan_id: string;
  saga_name: string;
  payload: Record<string, unknown>;
  device_id?: string;
}

export interface CollectionJobData {
  device_id: string;
  plan_id?: string;
  job_id?: string;
}

export interface DiagnosticsJobData {
  device_id: string;
  plan_id?: string;
  job_id?: string;
}

export interface TestingJobData {
  device_id: string;
  plan_id?: string;
  job_id?: string;
  duration?: string;
  intensity?: string;
}
