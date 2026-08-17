export interface RecoveryAction {
  rewindTo: string;
  description: string;
}

export interface SagaContext {
  planId: string;
  stepName: string;
  deviceId: unknown;
  payload: Record<string, unknown>;
  jobId: string;
  attempt: number;
  metadata: Record<string, unknown>;
  stepResults: Record<string, unknown>;
  signal?: AbortSignal;
  workId?: string;
}

export interface SagaStepExecutor {
  execute: (ctx: SagaContext) => Promise<unknown>;
}

export interface SagaStepDef {
  name: string;
  operation?: string;
  execute: (ctx: SagaContext) => Promise<unknown>;
  recovery?: RecoveryAction[];
  maxAttempts?: number;
}

export interface SagaDef {
  name: string;
  steps: SagaStepDef[];
}

export type RewindTo = string;
