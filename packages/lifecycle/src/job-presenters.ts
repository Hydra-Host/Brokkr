import type { LifecycleJobEvent as LifecycleJobEventDto, LifecycleJobSummary } from '@repo/api-client';
import type { LifecycleJob, LifecycleJobEvent } from '@repo/database';
import { redactPayload } from '@repo/utils';
import { HUB_STAMPED_EVENT_TYPES } from './lifecycle-hub-events';
import { LifecycleJobRecord } from './lifecycle-job.record';
import { TERMINAL_PHASES } from './lifecycle-state.machine';

export function toLifecycleJobSummary(row: LifecycleJob): LifecycleJobSummary {
  return {
    id: row.id,
    jobType: row.jobType,
    phase: row.phase,
    deviceId: row.deviceId,
    deploymentId: row.deploymentId,
    source: row.source,
    performedBy: row.performedBy,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    completedAt: TERMINAL_PHASES.has(row.phase) ? row.updatedAt.toISOString() : null,
  };
}

export function toLifecycleJobEvent(row: LifecycleJobEvent): LifecycleJobEventDto {
  return {
    id: row.id,
    sagaName: row.sagaName,
    stepName: row.stepName,
    operation: row.operation,
    eventType: row.eventType,
    status: row.status,
    result: redactPayload(row.result),
    error: row.error,
    attempt: row.attempt,
    occurredAt: row.occurredAt.toISOString(),
    recordedAt: row.recordedAt.toISOString(),
    origin: HUB_STAMPED_EVENT_TYPES.has(row.eventType) ? 'hub' : 'bridge',
  };
}

export async function readJobEvents(
  jobId: string,
  cap: number,
): Promise<{ events: LifecycleJobEventDto[]; truncated: boolean }> {
  // one past the cap, so a full page is distinguishable from a job with exactly that many events
  const rows = await LifecycleJobRecord.listEventsUnscoped(jobId, cap + 1);
  return { events: rows.slice(0, cap).map(toLifecycleJobEvent), truncated: rows.length > cap };
}

/** The renter's view of a job, named field by field so a new schema field fails to compile until classified. */
export function toCustomerJobSummary(summary: LifecycleJobSummary): LifecycleJobSummary {
  return {
    id: summary.id,
    jobType: summary.jobType,
    phase: summary.phase,
    deviceId: summary.deviceId,
    deploymentId: summary.deploymentId,
    source: summary.source,
    performedBy: null,
    error: null,
    createdAt: summary.createdAt,
    completedAt: summary.completedAt,
  };
}

/** The renter's view of a step: results and bridge errors carry hardware and network detail. */
export function toCustomerJobEvent(event: LifecycleJobEventDto): LifecycleJobEventDto {
  return {
    id: event.id,
    sagaName: event.sagaName,
    stepName: event.stepName,
    operation: event.operation,
    eventType: event.eventType,
    status: event.status,
    result: null,
    error: null,
    attempt: event.attempt,
    occurredAt: event.occurredAt,
    recordedAt: event.recordedAt,
    origin: event.origin,
  };
}
