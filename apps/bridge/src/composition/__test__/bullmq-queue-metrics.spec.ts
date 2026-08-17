import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RecordingMeterFake } from '../../__test__/telemetry-meter-fake';
import { createQueueJobsMetrics } from '../bullmq-factories';

const holder = vi.hoisted((): { fake: RecordingMeterFake | null } => ({ fake: null }));

vi.mock('@repo/telemetry', async () => {
  const { createRecordingMeterFake } = await import('../../__test__/telemetry-meter-fake');
  const fake = createRecordingMeterFake();
  holder.fake = fake;
  return {
    getTelemetryMeter: () => fake.meter,
    emitTelemetryLog: vi.fn(),
    getBullMqTelemetry: () => undefined,
    isTelemetryEnabled: () => false,
    enrichActiveSpan: vi.fn(),
  };
});

let telemetryFake: RecordingMeterFake;

const QUEUE_JOBS = 'brokkr.queue.jobs';

describe('bridge brokkr.queue.jobs gauge', () => {
  let metrics: ReturnType<typeof createQueueJobsMetrics>;

  beforeEach(() => {
    const fake = holder.fake;
    if (fake === null) throw new Error('@repo/telemetry mock did not install the meter fake');
    telemetryFake = fake;
    telemetryFake.reset();
    metrics = createQueueJobsMetrics();
  });

  it('observes one point per tracked queue and state', async () => {
    metrics.track('lifecycle', {
      getJobCounts: async () => ({ waiting: 2, active: 1, failed: 0, delayed: 3 }),
    });

    const observed = await telemetryFake.collect(QUEUE_JOBS);
    expect(observed).toEqual([
      { value: 2, attrs: { queue: 'lifecycle', state: 'waiting' } },
      { value: 1, attrs: { queue: 'lifecycle', state: 'active' } },
      { value: 0, attrs: { queue: 'lifecycle', state: 'failed' } },
      { value: 3, attrs: { queue: 'lifecycle', state: 'delayed' } },
    ]);
  });

  it('defaults missing states to 0', async () => {
    metrics.track('inbox', { getJobCounts: async () => ({}) });

    const observed = await telemetryFake.collect(QUEUE_JOBS);
    expect(observed).toHaveLength(4);
    expect(observed.every((entry) => entry.value === 0)).toBe(true);
  });

  it('swallows a failing queue and still reports the healthy ones', async () => {
    metrics.track('lifecycle', {
      getJobCounts: async () => ({ waiting: 5, active: 0, failed: 0, delayed: 0 }),
    });
    metrics.track('inbox', {
      getJobCounts: async () => {
        throw new Error('connection closed');
      },
    });

    const observed = await telemetryFake.collect(QUEUE_JOBS);
    expect(observed).toHaveLength(4);
    expect(observed[0]).toEqual({ value: 5, attrs: { queue: 'lifecycle', state: 'waiting' } });
  });

  it('a rebuilt handle replaces its predecessor and the gauge registers once', async () => {
    const stale = vi.fn(async () => ({ waiting: 99, active: 0, failed: 0, delayed: 0 }));
    metrics.track('lifecycle', { getJobCounts: stale });
    metrics.track('lifecycle', {
      getJobCounts: async () => ({ waiting: 1, active: 0, failed: 0, delayed: 0 }),
    });
    metrics.track('collection', {
      getJobCounts: async () => ({ waiting: 0, active: 0, failed: 0, delayed: 0 }),
    });

    const observed = await telemetryFake.collect(QUEUE_JOBS);
    expect(observed).toHaveLength(8);
    expect(stale).not.toHaveBeenCalled();
    expect(observed[0]).toEqual({ value: 1, attrs: { queue: 'lifecycle', state: 'waiting' } });
  });
});
