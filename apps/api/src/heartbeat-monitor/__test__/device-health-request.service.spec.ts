import { NotFoundException } from '@nestjs/common';
import { BaremetalRecord } from 'src/devices/baremetal.record';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeviceHealthRequestService } from '../device-health-request.service';

const DEVICE = '22222222-2222-2222-2222-222222222222';

function setup() {
  const dispatcher = { dispatch: vi.fn().mockResolvedValue({ jobId: 'health-request-1' }) };
  const contextService = { requirePermission: vi.fn() };
  const pin = vi
    .spyOn(BaremetalRecord, 'findByDeviceIdOrThrow')
    .mockResolvedValue({ data: { id: DEVICE } } as unknown as BaremetalRecord);
  const service = new DeviceHealthRequestService(dispatcher, contextService);
  return { service, dispatcher, contextService, pin };
}

describe('DeviceHealthRequestService.request', () => {
  afterEach(() => vi.restoreAllMocks());

  it('propagates the tenant pin failure without dispatching', async () => {
    const { service, dispatcher, pin } = setup();
    pin.mockRejectedValue(new NotFoundException('Server not found'));
    await expect(service.request(DEVICE)).rejects.toBeInstanceOf(NotFoundException);
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('requires the permission after the pin and returns the dispatcher result', async () => {
    const { service, dispatcher, contextService, pin } = setup();
    const out = await service.request(DEVICE);
    expect(out).toEqual({ jobId: 'health-request-1' });
    expect(pin).toHaveBeenCalledWith(DEVICE);
    expect(contextService.requirePermission).toHaveBeenCalledWith('device', 'health-check');
    expect(dispatcher.dispatch).toHaveBeenCalledWith(DEVICE);
  });
});
