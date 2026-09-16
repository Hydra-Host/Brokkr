import { UnrecoverableError } from 'bullmq';

import { FRESHNESS_WINDOW_MS } from '../zone-crypto/sealed-envelope.types';

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
export const AGENT_WAIT_REDELAY_SLACK_SECONDS = 60;
export const HANDOFF_REDELAY_ESCALATION: ReadonlyArray<{ maxElapsedSeconds: number; delaySeconds: number }> = [
  { maxElapsedSeconds: 60, delaySeconds: AGENT_HANDOFF_REDELAY_SECONDS },
  { maxElapsedSeconds: 600, delaySeconds: 60 },
  {
    maxElapsedSeconds: Number.POSITIVE_INFINITY,
    delaySeconds: (FRESHNESS_WINDOW_MS / 1_000 - AGENT_WAIT_REDELAY_SLACK_SECONDS) / 2,
  },
];
export const HANDOFF_DEFER_REDIS_KEY_PREFIX = 'handoff-defer';
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

export class AgentWaitExceeded extends UnrecoverableError {
  constructor(
    readonly deviceId: string,
    readonly elapsed: number,
    readonly attempts: number,
  ) {
    super(`no agent session for device ${deviceId} after ${elapsed.toFixed(0)}s (${attempts} handoff attempts)`);
    this.name = 'AgentWaitExceeded';
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
