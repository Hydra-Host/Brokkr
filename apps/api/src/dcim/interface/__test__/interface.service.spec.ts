import { Test } from '@nestjs/testing';
import { InterfaceType } from '@repo/database';
import { NetplanLiveInvalidatorService } from 'src/brokkr-bridge/netplan/netplan-live-invalidator.service';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InterfaceRecord } from '../interface.record';
import { InterfaceService } from '../interface.service';

const DEVICE_ID = 'device-1';
const IFACE_ID = 'if-1';

function interfaceRow(overrides: Partial<InterfaceRecord['data']> = {}) {
  return {
    id: IFACE_ID,
    deviceId: DEVICE_ID,
    name: 'eth0',
    type: InterfaceType.ETHERNET_25G,
    enabled: true,
    mtu: 1500,
    macAddress: null,
    speed: null,
    mgmtOnly: false,
    markConnected: false,
    mode: null,
    description: null,
    linkType: null,
    guid: null,
    portState: null,
    maxSpeedGbps: null,
    pciDeviceId: null,
    lldpNeighborName: null,
    lldpNeighborPort: null,
    lldpNeighborDescr: null,
    lldpNeighborMgmtIp: null,
    lagId: null,
    parentId: null,
    untaggedVlanId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function persistedInterface(overrides: Partial<InterfaceRecord['data']> = {}): InterfaceRecord {
  return InterfaceRecord.fromRow(interfaceRow(overrides));
}

describe('InterfaceService live netplan invalidation', () => {
  let service: InterfaceService;
  const forDevice = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    forDevice.mockResolvedValue(undefined);
    const module = await Test.createTestingModule({
      providers: [InterfaceService, { provide: NetplanLiveInvalidatorService, useValue: { forDevice } }],
    }).compile();
    service = module.get(InterfaceService);
  });

  afterEach(() => vi.restoreAllMocks());

  it('invalidates the live netplan when an interface is renamed', async () => {
    vi.spyOn(InterfaceRecord, 'updateById').mockResolvedValue(persistedInterface({ name: 'eth1' }));

    const result = await service.update(IFACE_ID, { name: 'eth1' });

    expect(result.name).toBe('eth1');
    expect(forDevice).toHaveBeenCalledWith(DEVICE_ID);
  });

  it('invalidates the live netplan when an interface is created', async () => {
    vi.spyOn(InterfaceRecord, 'createForDevice').mockResolvedValue(persistedInterface());

    await service.create(DEVICE_ID, { name: 'eth0' });

    expect(forDevice).toHaveBeenCalledWith(DEVICE_ID);
  });

  it('invalidates the live netplan after an interface is deleted', async () => {
    const deleteById = vi.spyOn(InterfaceRecord, 'deleteById').mockResolvedValue({ deviceId: DEVICE_ID });

    await service.delete(IFACE_ID);

    expect(deleteById).toHaveBeenCalledWith(IFACE_ID);
    expect(forDevice).toHaveBeenCalledWith(DEVICE_ID);
    expect(deleteById.mock.invocationCallOrder[0]).toBeLessThan(forDevice.mock.invocationCallOrder[0]);
  });

  it('invalidates the live netplan once after a bulk apply', async () => {
    vi.spyOn(InterfaceRecord, 'bulkApplyForDevice').mockResolvedValue(undefined);

    await service.bulkApply(DEVICE_ID, { deletes: [], updates: [{ id: IFACE_ID, name: 'eth1' }], creates: [] });

    expect(forDevice).toHaveBeenCalledTimes(1);
    expect(forDevice).toHaveBeenCalledWith(DEVICE_ID);
  });

  it('leaves the live netplan alone when the interface update rejects', async () => {
    vi.spyOn(InterfaceRecord, 'updateById').mockRejectedValue(new Error('name taken'));

    await expect(service.update(IFACE_ID, { name: 'eth1' })).rejects.toThrow('name taken');
    expect(forDevice).not.toHaveBeenCalled();
  });

  it('leaves the live netplan alone when the interface create rejects', async () => {
    vi.spyOn(InterfaceRecord, 'createForDevice').mockRejectedValue(new Error('name taken'));

    await expect(service.create(DEVICE_ID, { name: 'eth0' })).rejects.toThrow('name taken');
    expect(forDevice).not.toHaveBeenCalled();
  });

  it('leaves the live netplan alone when the interface delete rejects', async () => {
    vi.spyOn(InterfaceRecord, 'deleteById').mockRejectedValue(new Error('interface not found'));

    await expect(service.delete(IFACE_ID)).rejects.toThrow('interface not found');
    expect(forDevice).not.toHaveBeenCalled();
  });

  it('leaves the live netplan alone when the bulk apply rejects', async () => {
    vi.spyOn(InterfaceRecord, 'bulkApplyForDevice').mockRejectedValue(new Error('name taken'));

    await expect(
      service.bulkApply(DEVICE_ID, { deletes: [], updates: [{ id: IFACE_ID, name: 'eth1' }], creates: [] }),
    ).rejects.toThrow('name taken');
    expect(forDevice).not.toHaveBeenCalled();
  });
});
