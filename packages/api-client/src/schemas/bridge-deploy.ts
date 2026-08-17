import { z } from 'zod';

export const BridgeDeployStepStatusSchema = z
  .enum(['ok', 'error', 'skipped'])
  .describe('Outcome of a single deploy step (validate, plan, or submit)');

export type BridgeDeployStepStatus = z.infer<typeof BridgeDeployStepStatusSchema>;

export const BridgeDeployValidateResultSchema = z.object({
  status: BridgeDeployStepStatusSchema.describe('Outcome of the Nomad job validation step'),
  errors: z.array(z.string()).optional().describe('Nomad validation errors, if any'),
  warnings: z.string().nullable().optional().describe('Nomad validation warnings, null if none'),
});

export type BridgeDeployValidateResult = z.infer<typeof BridgeDeployValidateResultSchema>;

export const BridgeDeployPlanResultSchema = z.object({
  status: BridgeDeployStepStatusSchema.describe('Outcome of the Nomad plan step'),
  error: z.string().nullable().optional().describe('Error message if the plan step failed, null otherwise'),
  diffSummary: z
    .string()
    .nullable()
    .optional()
    .describe('Human-readable plan diff summary (e.g. "2 task groups created, 1 updated"), null if unavailable'),
  failedPlacements: z.boolean().describe('True if the plan reported FailedTGAllocs (placement could not be satisfied)'),
  warnings: z.string().nullable().optional().describe('Nomad plan warnings, null if none'),
});

export type BridgeDeployPlanResult = z.infer<typeof BridgeDeployPlanResultSchema>;

export const BridgeDeploySubmitResultSchema = z.object({
  status: BridgeDeployStepStatusSchema.describe('Outcome of the Nomad job submission step'),
  error: z.string().nullable().optional().describe('Error message if submission failed, null otherwise'),
  evalId: z.string().nullable().describe('Nomad evaluation ID on success, null if not submitted'),
  jobId: z.string().nullable().describe('Registered Nomad job ID, null if not submitted'),
});

export type BridgeDeploySubmitResult = z.infer<typeof BridgeDeploySubmitResultSchema>;

export const BridgeStartupStageSchema = z
  .enum(['submitted', 'scheduling', 'placed', 'starting', 'running', 'failed', 'timed_out'])
  .describe('Current lifecycle stage of the bridge job startup as observed by the status poll');

export type BridgeStartupStage = z.infer<typeof BridgeStartupStageSchema>;

export const BridgeStartupTaskStatusSchema = z.object({
  task: z.string().describe('Name of the Nomad task'),
  taskGroup: z.string().describe('Name of the Nomad task group the task belongs to'),
  allocId: z.string().describe('ID of the allocation the task ran in'),
  state: z.string().describe('Raw Nomad task state (e.g. "running", "pending", "dead")'),
  startedAt: z.string().nullable().describe('ISO 8601 timestamp when the task started, null if not yet started'),
  failed: z.boolean().describe('True if the task has entered a failed state'),
  failureReason: z
    .string()
    .nullable()
    .optional()
    .describe("Reason from the task's last failing event DisplayMessage, null if not failed"),
});

export type BridgeStartupTaskStatus = z.infer<typeof BridgeStartupTaskStatusSchema>;

export const BridgeStartupStatusSchema = z.object({
  stage: BridgeStartupStageSchema.describe('Current lifecycle stage of the bridge job startup'),
  done: z.boolean().describe('True once polling has reached a terminal verdict'),
  ok: z
    .boolean()
    .nullable()
    .describe('True if the job started cleanly, false if it failed, null while still in progress'),
  tasks: z.array(BridgeStartupTaskStatusSchema).describe('Per-task status snapshot from the latest poll'),
  failures: z.array(z.string()).describe('Human-readable failure reasons collected during startup'),
  softTimeoutReached: z
    .boolean()
    .describe(
      'True once the soft timeout (~60s) has elapsed without a terminal verdict; drives the "taking longer than usual" wait/investigate prompt in the UI',
    ),
  message: z
    .string()
    .nullable()
    .optional()
    .describe('Optional status note (e.g. "taking longer than usual"), null if none'),
});

export type BridgeStartupStatus = z.infer<typeof BridgeStartupStatusSchema>;

export const BridgeZoneDeployResultSchema = z.object({
  zoneId: z.string().describe('Zone ID that was targeted by the deploy'),
  operation: z.string().describe('Deploy operation performed (bootstrap | networks | services | etc.)'),
  status: z.enum(['success', 'failed', 'pending']).describe('Overall per-zone deploy outcome'),
  validate: BridgeDeployValidateResultSchema.describe('Result of the Nomad validation step'),
  plan: BridgeDeployPlanResultSchema.describe('Result of the Nomad plan step'),
  submit: BridgeDeploySubmitResultSchema.describe('Result of the Nomad job submission step'),
  submittedAt: z
    .string()
    .nullable()
    .describe('ISO 8601 timestamp when the job was submitted to Nomad, null if submission was not reached'),
  startup: BridgeStartupStatusSchema.nullable()
    .optional()
    .describe('Startup status populated by the later status poll, null if not yet observed'),
});

export type BridgeZoneDeployResult = z.infer<typeof BridgeZoneDeployResultSchema>;

export const BridgeDeployResultSchema = z.object({
  total: z.number().describe('Total number of zones targeted by the deploy'),
  successful: z.number().describe('Number of zones that deployed successfully'),
  failed: z.number().describe('Number of zones that failed to deploy'),
  results: z.array(BridgeZoneDeployResultSchema).describe('Per-zone deploy results'),
});

export type BridgeDeployResult = z.infer<typeof BridgeDeployResultSchema>;
