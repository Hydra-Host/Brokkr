import { AdminLifecycleRequestStatus, AdminLifecycleRequestType } from '@repo/database/enums';
import { z } from 'zod';
import { zodEnumFromPrisma } from './prisma-enum';

export const LifecycleRequestTypeSchema = zodEnumFromPrisma(AdminLifecycleRequestType).describe(
  'Type of destructive lifecycle action being requested',
);

export type LifecycleRequestType = z.infer<typeof LifecycleRequestTypeSchema>;

export const LifecycleRequestStatusSchema = zodEnumFromPrisma(AdminLifecycleRequestStatus).describe(
  'Current status of the lifecycle request',
);

export type LifecycleRequestStatus = z.infer<typeof LifecycleRequestStatusSchema>;

export const LifecycleRequestResponseSchema = z.object({
  id: z.string().describe('Unique identifier for the lifecycle request'),
  deploymentId: z.string().describe('ID of the deployment this request targets'),
  type: z.string().describe('Type of lifecycle action requested (DEPROVISION, REPROVISION, PROVISION)'),
  status: z.string().describe('Current request status (PENDING, APPROVED, REJECTED, EXECUTED)'),
  requestBody: z
    .record(z.string(), z.unknown())
    .describe(
      'Request metadata stored with the request. Typically `{ notes }` for the operator explanation shown to the customer, or `{}`.',
    ),
  requestedByName: z.string().nullable().describe('Name of the admin who created the request'),
  approvedAt: z.string().nullable().describe('ISO 8601 timestamp when the request was approved'),
  rejectedAt: z.string().nullable().describe('ISO 8601 timestamp when the request was rejected'),
  executedAt: z.string().nullable().describe('ISO 8601 timestamp when the action was executed'),
  createdAt: z.string().describe('ISO 8601 timestamp when the request was created'),
});

export type LifecycleRequestResponse = z.infer<typeof LifecycleRequestResponseSchema>;
