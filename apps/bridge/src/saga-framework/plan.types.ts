import type { JobStatus } from './state.types';

export type LifecyclePlanStepResult = unknown;

export interface LifecyclePlanStep {
  step_name: string;
  operation: string;
  status: JobStatus;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  error: string | null;
  result: LifecyclePlanStepResult;
  job_id: string | null;
  queue_name: string | null;
  attempt: number;
}

export interface LifecyclePlan {
  plan_id: string;
  device_id: unknown;
  job_class: string;
  status: JobStatus;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  error: string | null;
  metadata: Record<string, unknown>;
  steps: LifecyclePlanStep[];
}
