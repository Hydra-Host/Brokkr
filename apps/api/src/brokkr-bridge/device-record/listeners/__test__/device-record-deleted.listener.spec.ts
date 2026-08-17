import { describe, expect, it, vi } from 'vitest';
import type { DeviceSoftDeletedEvent } from 'src/devices/device-lifecycle.events';
import type { DeviceRecordPublisher } from '../../device-record-publisher.service';
import { DeviceRecordDeletedListener } from '../device-record-deleted.listener';

const fakeLogger: any = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const makeEvent = (overrides: Partial<DeviceSoftDeletedEvent> = {}): DeviceSoftDeletedEvent => ({
  deviceId: 'dev-uuid-1',
  ...overrides,
});

describe('DeviceRecordDeletedListener', () => {
  it('tears down the device_record by calling publisher.delete with the payload deviceId', async () => {
    const publisher = {
      delete: vi.fn().mockResolvedValue(undefined),
    } as unknown as DeviceRecordPublisher;
    const listener = new DeviceRecordDeletedListener(publisher, fakeLogger);

    await listener.onSoftDeleted(makeEvent());

    expect(publisher.delete).toHaveBeenCalledWith('dev-uuid-1');
  });

  it('swallows publisher errors (logs but does not throw — best-effort teardown)', async () => {
    fakeLogger.warn.mockClear();
    const publisher = {
      delete: vi.fn().mockRejectedValue(new Error('redis down')),
    } as unknown as DeviceRecordPublisher;
    const listener = new DeviceRecordDeletedListener(publisher, fakeLogger);

    await expect(listener.onSoftDeleted(makeEvent())).resolves.toBeUndefined();
    expect(fakeLogger.warn).toHaveBeenCalled();
  });
});
