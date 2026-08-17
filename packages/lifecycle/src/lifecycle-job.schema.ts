import { JobType, LifecycleJobPhase, RequestSource } from '@repo/database';
import { z } from 'zod';

export const LifecycleJobPersistenceSchema = z.object({
  id: z.string(),
  jobType: z.nativeEnum(JobType),
  phase: z.nativeEnum(LifecycleJobPhase),
  payload: z.unknown(),
  deviceId: z.string().nullable(),
  deploymentId: z.string().nullable(),
  organizationId: z.string().nullable(),
  source: z.nativeEnum(RequestSource),
  performedBy: z.string().nullable(),
  scheduledAt: z.date().nullable(),
  phoneHomeDeadline: z.date().nullable(),
  linkedJobId: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
