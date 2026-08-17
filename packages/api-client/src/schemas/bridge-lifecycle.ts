import { z } from 'zod';

export const BridgeLifecycleActionTypeSchema = z
  .enum(['deprovision', 'provision', 'reprovision', 'commission'])
  .describe('Type of lifecycle action being performed on the device');

export const BridgeLifecycleEventTypeSchema = z
  .enum(['job_started', 'stage_changed', 'job_completed', 'job_failed'])
  .describe('Current state of the lifecycle job');

export const BridgeLifecycleEventSchema = z
  .object({
    device_id: z.coerce.number().describe('Device ID'),
    job_id: z.string().describe('Unique job identifier for this lifecycle operation'),
    tenant_id: z.number().int().positive().optional().describe('Tenant ID for zone validation'),
    action_type: BridgeLifecycleActionTypeSchema.describe('Type of lifecycle action being performed on the device'),
    event_type: BridgeLifecycleEventTypeSchema.describe('Current state of the lifecycle job'),
    event: z.string().optional().describe('Event name from bridge-api step transitions'),
    step_name: z.string().optional().describe('Saga step name'),
    status: z.string().optional().describe('Step status from bridge-api'),
    timestamp: z.string().describe('ISO 8601 timestamp of when the event occurred'),
    stage: z.string().optional().describe('Current stage name during stage_changed events'),
    message: z.string().optional().describe('Human-readable description of what is happening'),
    attempt: z.number().optional().describe('Retry attempt number'),
    result: z.record(z.unknown()).optional().nullable().describe('Step result data'),
    error: z
      .object({
        stage: z.string().optional().describe('Stage where the failure occurred'),
        message: z.string().optional().describe('Error description'),
      })
      .optional()
      .nullable()
      .describe('Error details'),
  })
  .passthrough();

export type BridgeLifecycleEvent = z.infer<typeof BridgeLifecycleEventSchema>;

export const BridgeLifecycleEventResponseSchema = z.object({
  success: z.boolean().describe('Whether the event was processed successfully'),
});

export type BridgeLifecycleEventResponse = z.infer<typeof BridgeLifecycleEventResponseSchema>;
