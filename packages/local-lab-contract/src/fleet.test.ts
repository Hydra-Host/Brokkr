import { isAppRoute } from '@ts-rest/core';
import { describe, expect, it } from 'vitest';
import { contract } from './index';
import { MachineSchema } from './schemas/fleet';

const DEVICE = '00000000-0000-0000-0000-000000000001';

const machine = (over: Record<string, unknown> = {}) => ({
  name: 'cpu-1',
  power: 'on',
  configured: true,
  deviceId: DEVICE,
  ...over,
});

function listRoute() {
  const route = contract.listMachines;
  if (!isAppRoute(route)) throw new Error('listMachines not a route');
  return route;
}

describe('MachineSchema', () => {
  it('carries the hub device id a configured machine derives from its fleet index', () => {
    expect(MachineSchema.parse(machine()).deviceId).toBe(DEVICE);
  });

  it('accepts a null device id for a domain outside the fleet config', () => {
    expect(MachineSchema.parse(machine({ configured: false, deviceId: null }))).toMatchObject({
      configured: false,
      deviceId: null,
    });
  });

  it('requires deviceId to be present rather than absent', () => {
    const { deviceId: _deviceId, ...noDeviceId } = machine();
    expect(() => MachineSchema.parse(noDeviceId)).toThrow();
  });

  it('describes every field', () => {
    for (const [name, field] of Object.entries(MachineSchema.shape)) {
      expect(field.description, `${name} is missing a describe()`).toBeTruthy();
    }
  });
});

describe('listMachines', () => {
  it('returns machines with and without a device id in one roster', () => {
    expect(
      listRoute().responses[200].parse([machine(), machine({ name: 'ghost', configured: false, deviceId: null })]),
    ).toEqual([
      { name: 'cpu-1', power: 'on', configured: true, deviceId: DEVICE },
      { name: 'ghost', power: 'on', configured: false, deviceId: null },
    ]);
  });

  it('rejects a roster entry that omits the device id', () => {
    const { deviceId: _deviceId, ...noDeviceId } = machine();
    expect(() => listRoute().responses[200].parse([noDeviceId])).toThrow();
  });
});
