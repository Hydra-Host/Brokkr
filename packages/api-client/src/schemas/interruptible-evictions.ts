import { z } from 'zod';

export const PendingInterruptibleEvictionSchema = z.object({
  id: z.string().describe('Unique identifier of the pending admin lifecycle request.'),
  deploymentId: z
    .string()
    .describe('ID of the outgoing (currently active) deployment whose eviction is awaiting approval.'),
  deviceId: z.string().describe('ID of the host device whose interruptible tenant would be evicted.'),
  requestedByName: z
    .string()
    .nullable()
    .describe('Display name of the incoming requester who triggered the interruptible provision.'),
  deploymentName: z
    .string()
    .describe('Nickname the incoming requester chose for the deployment that would replace the evicted tenant.'),
  operatingSystemSlug: z
    .string()
    .describe('Operating system slug the incoming provision would install after the eviction completes.'),
  status: z.string().describe('Current status of the request (always PENDING for this list).'),
  createdAt: z.string().describe('ISO 8601 timestamp when the eviction approval was requested.'),
});

export type PendingInterruptibleEviction = z.infer<typeof PendingInterruptibleEvictionSchema>;

export const InterruptibleEvictionActionResponseSchema = z.object({
  success: z.boolean().describe('Whether the authorize or reject action completed successfully.'),
});

export type InterruptibleEvictionActionResponse = z.infer<typeof InterruptibleEvictionActionResponseSchema>;
