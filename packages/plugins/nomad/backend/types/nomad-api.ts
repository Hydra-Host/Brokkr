import { z } from 'zod';

/** Zod schemas for Nomad HTTP responses (v0); no Vault/Prisma shapes. */

/** Opaque Job JSON from POST /v1/jobs/parse — passed through unchanged. */
export const NomadParsedJobSchema = z.record(z.unknown());
export type NomadParsedJob = z.infer<typeof NomadParsedJobSchema>;

export const NomadValidateJobResponseSchema = z.object({
  ValidationErrors: z.array(z.string()).nullable().optional(),
  Warnings: z.string().optional(),
  Error: z.string().optional(),
  DriverConfigValidated: z.boolean().optional(),
});
export type NomadValidateJobResponse = z.infer<typeof NomadValidateJobResponseSchema>;

export const NomadPlanJobResponseSchema = z.object({
  JobModifyIndex: z.number(),
  Diff: z.record(z.unknown()).nullable().optional(),
  FailedTGAllocs: z.record(z.unknown()).nullable().optional(),
  Warnings: z.string().optional(),
  Annotations: z.record(z.unknown()).nullable().optional(),
});
export type NomadPlanJobResponse = z.infer<typeof NomadPlanJobResponseSchema>;

export const NomadSubmitJobResponseSchema = z.object({
  EvalID: z.string(),
  EvalCreateIndex: z.number(),
  JobModifyIndex: z.number(),
});
export type NomadSubmitJobResponse = z.infer<typeof NomadSubmitJobResponseSchema>;

/** DELETE /v1/job/:id — same EvalID shape as register/update. */
export const NomadDeregisterJobResponseSchema = NomadSubmitJobResponseSchema;
export type NomadDeregisterJobResponse = z.infer<typeof NomadDeregisterJobResponseSchema>;

export const NomadDispatchJobResponseSchema = z.object({
  DispatchedJobID: z.string(),
  EvalID: z.string(),
  EvalCreateIndex: z.number().optional(),
  JobCreateIndex: z.number().optional(),
  Index: z.number().optional(),
});
export type NomadDispatchJobResponse = z.infer<typeof NomadDispatchJobResponseSchema>;

// Status reads (evaluation / allocations / job summary)

export const NomadEvaluationStatusSchema = z.object({
  ID: z.string(),
  JobID: z.string(),
  Status: z.string(),
  Type: z.string().optional(),
  TriggeredBy: z.string().optional(),
  Wait: z.number().optional(),
  BlockedEval: z.string().optional(),
  FailedTGAllocs: z.record(z.unknown()).nullable().optional(),
});
export type NomadEvaluationStatus = z.infer<typeof NomadEvaluationStatusSchema>;

export const NomadTaskEventSchema = z.object({
  Type: z.string(),
  Time: z.number().optional(),
  DisplayMessage: z.string().optional(),
});
export type NomadTaskEvent = z.infer<typeof NomadTaskEventSchema>;

export const NomadTaskStateSchema = z.object({
  State: z.string(),
  Failed: z.boolean(),
  StartedAt: z.string().nullable().optional(),
  FinishedAt: z.string().nullable().optional(),
  Events: z.array(NomadTaskEventSchema).optional(),
});
export type NomadTaskState = z.infer<typeof NomadTaskStateSchema>;

export const NomadAllocStubSchema = z.object({
  ID: z.string(),
  JobID: z.string(),
  Name: z.string().optional(),
  NodeID: z.string().optional(),
  NodeName: z.string().optional(),
  TaskGroup: z.string().optional(),
  ClientStatus: z.string(),
  DesiredStatus: z.string().optional(),
  JobVersion: z.number().optional(),
  CreateTime: z.number().optional(),
  ModifyTime: z.number().optional(),
  TaskStates: z.record(NomadTaskStateSchema).nullable().optional(),
  NextAllocation: z.string().nullable().optional(),
});
export type NomadAllocStub = z.infer<typeof NomadAllocStubSchema>;

export const NomadJobAllocationsResponseSchema = z.array(NomadAllocStubSchema);
export type NomadJobAllocationsResponse = z.infer<typeof NomadJobAllocationsResponseSchema>;

// Node reads (list stubs omit Meta/Attributes; detail carries them)

export const NomadDriverInfoSchema = z.object({
  Detected: z.boolean().nullable().optional(),
  Healthy: z.boolean().nullable().optional(),
});
export type NomadDriverInfo = z.infer<typeof NomadDriverInfoSchema>;

export const NomadNodeStubSchema = z.object({
  ID: z.string(),
  Name: z.string(),
  Status: z.string(),
  SchedulingEligibility: z.string(),
  Datacenter: z.string().optional(),
  NodePool: z.string().optional(),
  Address: z.string().optional(),
  Version: z.string().optional(),
  Drivers: z.record(NomadDriverInfoSchema).nullable().optional(),
});
export type NomadNodeStub = z.infer<typeof NomadNodeStubSchema>;

export const NomadNodesResponseSchema = z.array(NomadNodeStubSchema);
export type NomadNodesResponse = z.infer<typeof NomadNodesResponseSchema>;

/** GET /v1/node/:id — no top-level Version; agent version lives in Attributes["nomad.version"]. */
export const NomadNodeDetailSchema = z.object({
  ID: z.string(),
  Name: z.string(),
  Status: z.string(),
  SchedulingEligibility: z.string(),
  Datacenter: z.string().optional(),
  NodePool: z.string().optional(),
  HTTPAddr: z.string().optional(),
  Attributes: z.record(z.string()).nullable().optional(),
  Meta: z.record(z.string()).nullable().optional(),
  Drivers: z.record(NomadDriverInfoSchema).nullable().optional(),
});
export type NomadNodeDetail = z.infer<typeof NomadNodeDetailSchema>;

/** GET /v1/job/:id task fields used by deploy prefill; everything else passes through. */
export const NomadJobDetailTaskSchema = z
  .object({
    Name: z.string().nullable().optional(),
    Config: z.record(z.unknown()).nullable().optional(),
    Resources: z
      .object({
        CPU: z.number().nullable().optional(),
        MemoryMB: z.number().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    Env: z.record(z.string()).nullable().optional(),
  })
  .passthrough();
export type NomadJobDetailTask = z.infer<typeof NomadJobDetailTaskSchema>;

export const NomadJobDetailTaskGroupSchema = z
  .object({
    Name: z.string().nullable().optional(),
    Tasks: z.array(NomadJobDetailTaskSchema).nullable().optional(),
  })
  .passthrough();
export type NomadJobDetailTaskGroup = z.infer<typeof NomadJobDetailTaskGroupSchema>;

export const NomadJobDetailSchema = z
  .object({
    ID: z.string().nullable().optional(),
    Name: z.string().nullable().optional(),
    Status: z.string().nullable().optional(),
    TaskGroups: z.array(NomadJobDetailTaskGroupSchema).nullable().optional(),
  })
  .passthrough();
export type NomadJobDetail = z.infer<typeof NomadJobDetailSchema>;

export const NomadJobSummarySchema = z.object({
  Status: z.string().nullable().optional(),
  Version: z.number().nullable().optional(),
  TaskGroups: z
    .array(
      z.object({
        Name: z.string(),
        Tasks: z
          .array(z.object({ Name: z.string() }))
          .nullable()
          .optional(),
      }),
    )
    .nullable()
    .optional(),
});
export type NomadJobSummary = z.infer<typeof NomadJobSummarySchema>;

// Method params

export const ParseJobParamsSchema = z.object({
  jobHCL: z.string(),
  namespace: z.string().optional(),
  canonicalize: z.boolean().optional(),
  variables: z.string().optional(),
});
export type ParseJobParams = z.infer<typeof ParseJobParamsSchema>;

export const ValidateJobParamsSchema = z.object({
  job: NomadParsedJobSchema,
  namespace: z.string().optional(),
});
export type ValidateJobParams = z.infer<typeof ValidateJobParamsSchema>;

export const PlanJobParamsSchema = z.object({
  jobId: z.string(),
  job: NomadParsedJobSchema,
  namespace: z.string().optional(),
  diff: z.boolean().optional(),
});
export type PlanJobParams = z.infer<typeof PlanJobParamsSchema>;

export const SubmitParsedJobParamsSchema = z.object({
  job: NomadParsedJobSchema,
  namespace: z.string().optional(),
});
export type SubmitParsedJobParams = z.infer<typeof SubmitParsedJobParamsSchema>;

export const GetEvaluationParamsSchema = z.object({
  evalId: z.string(),
  namespace: z.string().optional(),
});
export type GetEvaluationParams = z.infer<typeof GetEvaluationParamsSchema>;

export const GetJobAllocationsParamsSchema = z.object({
  jobId: z.string(),
  namespace: z.string().optional(),
});
export type GetJobAllocationsParams = z.infer<typeof GetJobAllocationsParamsSchema>;

export const GetJobParamsSchema = z.object({
  jobId: z.string(),
  namespace: z.string().optional(),
});
export type GetJobParams = z.infer<typeof GetJobParamsSchema>;

export const DeregisterJobParamsSchema = z.object({
  jobId: z.string(),
  namespace: z.string().optional(),
  purge: z.boolean().optional(),
});
export type DeregisterJobParams = z.infer<typeof DeregisterJobParamsSchema>;

export const GetNodeParamsSchema = z.object({
  nodeId: z.string(),
});
export type GetNodeParams = z.infer<typeof GetNodeParamsSchema>;

export const DispatchJobParamsSchema = z.object({
  jobId: z.string(),
  meta: z.record(z.string()).optional(),
  payload: z.string().optional(),
  namespace: z.string().optional(),
});
export type DispatchJobParams = z.infer<typeof DispatchJobParamsSchema>;

export const GetAllocLogsParamsSchema = z.object({
  allocId: z.string(),
  task: z.string(),
  type: z.enum(['stdout', 'stderr']),
  origin: z.enum(['start', 'end']).optional(),
  offset: z.number().optional(),
  namespace: z.string().optional(),
});
export type GetAllocLogsParams = z.infer<typeof GetAllocLogsParamsSchema>;
