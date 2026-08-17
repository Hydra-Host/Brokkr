import { JobType, LifecycleJobPhase, RequestSource } from '@repo/database';
import { LifecycleJobRecord } from '@repo/lifecycle';
import { vi } from 'vitest';

export function makeMockClient() {
  let row: Record<string, unknown> = {};
  return {
    lifecycleJob: {
      create: vi.fn((args: { data: Record<string, unknown> }) => {
        row = {
          deploymentId: null,
          scheduledAt: null,
          phoneHomeDeadline: null,
          linkedJobId: null,
          error: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...args.data,
        };
        return row;
      }),
      update: vi.fn((args: { data: Record<string, unknown> }) => {
        row = { ...row, ...args.data, updatedAt: new Date() };
        return row;
      }),
    },
  };
}

export function jobAt(phase: LifecycleJobPhase, jobType: JobType = JobType.Provision): LifecycleJobRecord {
  return LifecycleJobRecord.build({
    id: 'job-1',
    jobType,
    phase,
    deviceId: 'device-1',
    deploymentId: 'dep-1',
    organizationId: 'org-1',
    performedBy: 'user-1',
    source: RequestSource.API,
    payload: {},
  });
}
