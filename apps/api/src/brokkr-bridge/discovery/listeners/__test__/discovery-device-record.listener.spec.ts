import { describe, expect, it, vi } from 'vitest';
import type { DeviceRecordPublisher } from '../../../device-record/device-record-publisher.service';
import type { DiscoveryRunCompletedEvent } from '../../discovery.events';
import { DiscoveryDeviceRecordListener } from '../discovery-device-record.listener';

const fakeLogger: any = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const makeCompleted = (overrides: Partial<DiscoveryRunCompletedEvent> = {}): DiscoveryRunCompletedEvent => ({
  runId: 'run-1',
  deviceId: 'dev-uuid-1',
  zonePrefix: 'tenant-1-site-2-loc-3',
  jobId: 'job-1',
  storageLayouts: null,
  rawBundle: {},
  collectorsApplied: [],
  collectorsSkipped: [],
  composersApplied: [],
  issueCount: 0,
  durationMs: 42,
  ...overrides,
});

describe('DiscoveryDeviceRecordListener', () => {
  it('publishes the device_record atom on RunCompleted with the job id as request_id', async () => {
    const publisher = {
      writeForDevice: vi.fn().mockResolvedValue({ written: true }),
    } as unknown as DeviceRecordPublisher;
    const listener = new DiscoveryDeviceRecordListener(publisher, fakeLogger);

    await listener.onRunCompleted(makeCompleted());

    expect(publisher.writeForDevice).toHaveBeenCalledWith('dev-uuid-1', { requestId: 'job-1' });
  });

  it('swallows publisher errors (logs but does not throw — bridge can render-on-miss)', async () => {
    const publisher = {
      writeForDevice: vi.fn().mockRejectedValue(new Error('redis down')),
    } as unknown as DeviceRecordPublisher;
    const listener = new DiscoveryDeviceRecordListener(publisher, fakeLogger);

    await expect(listener.onRunCompleted(makeCompleted())).resolves.toBeUndefined();
    expect(fakeLogger.warn).toHaveBeenCalled();
  });

  it('warns (and does not throw) when the device_record publish is skipped by the staleness race', async () => {
    fakeLogger.warn.mockClear();
    const publisher = {
      writeForDevice: vi.fn().mockResolvedValue({ written: false, reason: 'stale' }),
    } as unknown as DeviceRecordPublisher;
    const listener = new DiscoveryDeviceRecordListener(publisher, fakeLogger);

    await expect(listener.onRunCompleted(makeCompleted())).resolves.toBeUndefined();
    expect(fakeLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Skipped device_record publish for discoveryCompletion'),
      'job-1',
    );
  });

  it('logs an expected skip (no warn) when the role is not published', async () => {
    fakeLogger.warn.mockClear();
    fakeLogger.log.mockClear();
    const publisher = {
      writeForDevice: vi.fn().mockResolvedValue({ written: false, reason: 'role-not-published' }),
    } as unknown as DeviceRecordPublisher;
    const listener = new DiscoveryDeviceRecordListener(publisher, fakeLogger);

    await expect(listener.onRunCompleted(makeCompleted())).resolves.toBeUndefined();
    expect(fakeLogger.warn).not.toHaveBeenCalled();
    expect(fakeLogger.log).toHaveBeenCalledWith(expect.stringContaining('not in the publish allow-list'), 'job-1');
  });
});
