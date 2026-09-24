import { JobType, LifecycleJobPhase } from '@repo/database/enums';
import { z } from 'zod';
import { PaginationQuerySchema } from './pagination';
import { zodEnumFromPrisma } from './prisma-enum';

export const LifecycleJobKindSchema = zodEnumFromPrisma(JobType).describe('Kind of lifecycle operation a job performs');

export const LifecycleJobPhaseSchema = zodEnumFromPrisma(LifecycleJobPhase).describe(
  'Engine state-machine phase of a lifecycle job',
);

export const LifecycleJobSummarySchema = z.object({
  id: z.string().uuid().describe('Lifecycle job identifier — the plan_id correlation key sent to bridges'),
  jobType: LifecycleJobKindSchema.describe('Kind of lifecycle operation'),
  phase: LifecycleJobPhaseSchema.describe('Current engine state-machine phase'),
  deviceId: z.string().nullable().describe('Target device id'),
  deploymentId: z.string().nullable().describe('Deployment the job acted on, when applicable'),
  source: z.string().describe('How the job was requested (UI, API, DEVICE, ...)'),
  performedBy: z.string().nullable().describe('User id that requested the job, when known'),
  error: z.string().nullable().describe('Failure summary for FAILED/ABORTED jobs'),
  createdAt: z.string().describe('ISO 8601 timestamp when the job was requested'),
  completedAt: z
    .string()
    .nullable()
    .describe('ISO 8601 timestamp when the job reached a terminal phase; null while in flight'),
});

export type LifecycleJobSummary = z.infer<typeof LifecycleJobSummarySchema>;

export const ListLifecycleJobsQuerySchema = PaginationQuerySchema.extend({
  deviceId: z.string().uuid().optional().describe('Filter jobs to a single device'),
  deploymentId: z.string().uuid().optional().describe('Filter jobs to a single deployment'),
});

export type ListLifecycleJobsQuery = z.infer<typeof ListLifecycleJobsQuerySchema>;

export const LIFECYCLE_JOB_EVENT_CAP = 500;

export const LifecycleJobEventSchema = z.object({
  id: z.string().describe('Event row id'),
  sagaName: z.string().describe('Bridge saga that produced the event, for example provision or power_on'),
  stepName: z
    .string()
    .describe("Step inside the saga; '(saga)' for the completion row, 'phone_home' for the hub-stamped phone-home row"),
  operation: z
    .string()
    .nullable()
    .describe(
      "The bridge's label for the step, for example 'Disable OS boot options'; null when the row carries none, such as the saga completion row or a row recorded before the label was carried",
    ),
  eventType: z
    .string()
    .describe(
      'Bridge event kind such as job_started, job_completed, job_failed; hub-stamped rows use power_watchdog, stuck_sweep, phone_home',
    ),
  status: z.string().describe('Step outcome the bridge reported, for example complete or failed'),
  result: z
    .unknown()
    .nullable()
    .describe('Redacted step result. Keys that look like secrets are removed and the payload is capped at 16 KiB'),
  error: z.string().nullable().describe('Error text the bridge reported for a failed step'),
  attempt: z.number().int().nonnegative().describe('Retry ordinal of the step; the only retry trace the hub holds'),
  occurredAt: z.string().describe('Event clock, ISO 8601. Bridge time for bridge rows, hub time for hub-stamped rows'),
  recordedAt: z.string().describe('Hub ingest clock, ISO 8601'),
  origin: z
    .enum(['bridge', 'hub'])
    .describe("'hub' for rows the engine stamped itself (power_watchdog, stuck_sweep, phone_home); 'bridge' otherwise"),
});
export type LifecycleJobEvent = z.infer<typeof LifecycleJobEventSchema>;

export const LifecycleJobEventsResponseSchema = z.object({
  data: z.array(LifecycleJobEventSchema).describe('Events oldest first'),
  meta: z.object({
    truncated: z.boolean().describe('True when the job holds more events than the cap; the newest are omitted'),
    cap: z.number().int().describe('Maximum events one response carries'),
  }),
});
export type LifecycleJobEventsResponse = z.infer<typeof LifecycleJobEventsResponseSchema>;
