import {
  DEVICE_HEALTH_RECORDED,
  DEVICE_METADATA_UPDATED,
  DeviceEventFrameSchema,
  JOB_EVENT_RECORDED,
} from '@repo/api-client';
import { describe, expect, it } from 'vitest';
import { DeviceEventSchema, SSE_CHANNEL, eventVisibleTo, toWire, type DeviceEvent } from '../device-events';

function metadataEvent(organizationId: string | null, supplierId: string | null = null): DeviceEvent {
  return {
    type: DEVICE_METADATA_UPDATED,
    deviceId: 'dev-1',
    deploymentId: null,
    organizationId,
    supplierId,
    status: 'inventory',
    powerStatus: null,
  };
}

function healthEvent(organizationId: string | null, supplierId: string | null = null): DeviceEvent {
  return {
    type: DEVICE_HEALTH_RECORDED,
    deviceId: 'dev-1',
    organizationId,
    supplierId,
    healthCheckId: 'hc-1',
    testedAt: '2026-09-17T00:00:00.000Z',
  };
}

const jobEvent: DeviceEvent = {
  type: JOB_EVENT_RECORDED,
  deviceId: 'dev-1',
  deploymentId: 'dep-1',
  organizationId: 'org-a',
  supplierId: null,
  jobId: 'job-1',
  phase: 'RUNNING',
};

describe('eventVisibleTo', () => {
  it('shows an unscoped viewer every metadata and health event', () => {
    const viewer = { organizationId: null, canReadJobs: false };

    expect(eventVisibleTo(metadataEvent(null), viewer)).toBe(true);
    expect(eventVisibleTo(metadataEvent('org-b'), viewer)).toBe(true);
    expect(eventVisibleTo(healthEvent('org-b', 'org-c'), viewer)).toBe(true);
  });

  it('shows a scoped viewer the devices it rents or owns', () => {
    const viewer = { organizationId: 'org-a', canReadJobs: false };

    expect(eventVisibleTo(metadataEvent('org-a'), viewer)).toBe(true);
    expect(eventVisibleTo(metadataEvent('org-b', 'org-a'), viewer)).toBe(true);
    expect(eventVisibleTo(healthEvent(null, 'org-a'), viewer)).toBe(true);
  });

  it('hides pool devices and other organizations from a scoped viewer', () => {
    const viewer = { organizationId: 'org-a', canReadJobs: false };

    expect(eventVisibleTo(metadataEvent(null), viewer)).toBe(false);
    expect(eventVisibleTo(metadataEvent('org-b'), viewer)).toBe(false);
    expect(eventVisibleTo(healthEvent('org-b', 'org-c'), viewer)).toBe(false);
  });

  it('shows a job event to a job reader and to the organization that requested it', () => {
    expect(eventVisibleTo(jobEvent, { organizationId: 'org-b', canReadJobs: true })).toBe(true);
    expect(eventVisibleTo(jobEvent, { organizationId: null, canReadJobs: true })).toBe(true);
    expect(eventVisibleTo(jobEvent, { organizationId: 'org-a', canReadJobs: false })).toBe(true);
    expect(eventVisibleTo(jobEvent, { organizationId: 'org-b', canReadJobs: false })).toBe(false);
  });

  it('never matches an unscoped viewer against a system job by their shared null organization', () => {
    const systemJob: DeviceEvent = { ...jobEvent, organizationId: null };

    expect(eventVisibleTo(jobEvent, { organizationId: null, canReadJobs: false })).toBe(false);
    expect(eventVisibleTo(systemJob, { organizationId: null, canReadJobs: false })).toBe(false);
    expect(eventVisibleTo(systemJob, { organizationId: 'org-a', canReadJobs: false })).toBe(false);
  });
});

describe('toWire', () => {
  it('drops the scoping ids from every frame kind', () => {
    for (const event of [metadataEvent('org-a', 'org-b'), jobEvent, healthEvent('org-a', 'org-b')]) {
      const frame = toWire(event);

      expect(frame).not.toHaveProperty('organizationId');
      expect(frame).not.toHaveProperty('supplierId');
      expect(DeviceEventFrameSchema.parse(frame)).toEqual(frame);
    }
  });

  it('keeps every wire field of the job frame', () => {
    expect(toWire(jobEvent)).toEqual({
      type: JOB_EVENT_RECORDED,
      deviceId: 'dev-1',
      deploymentId: 'dep-1',
      jobId: 'job-1',
      phase: 'RUNNING',
    });
  });
});

describe('DeviceEventSchema', () => {
  it('accepts a scoped event and rejects the bare wire frame', () => {
    expect(DeviceEventSchema.parse(jobEvent)).toEqual(jobEvent);
    expect(DeviceEventSchema.safeParse(toWire(jobEvent)).success).toBe(false);
  });
});

describe('SSE_CHANNEL', () => {
  it('names the channel the admin hub subscribes to by literal', () => {
    expect(SSE_CHANNEL).toBe('sse:device-metadata-updated');
  });
});
