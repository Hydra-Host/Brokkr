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
