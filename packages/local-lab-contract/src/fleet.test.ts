import { isAppRoute } from '@ts-rest/core';
import { describe, expect, it } from 'vitest';
import { contract } from './index';
import { FleetPendingSchema, FleetPlanesSchema, FleetVerifyReportSchema, MachineSchema } from './schemas/fleet';

const DEVICE = '00000000-0000-0000-0000-000000000001';

const machine = (over: Record<string, unknown> = {}) => ({
  name: 'cpu-1',
  kind: 'vm',
  power: 'on',
  configured: true,
  deviceId: DEVICE,
  bmc: null,
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
      { name: 'cpu-1', kind: 'vm', power: 'on', configured: true, deviceId: DEVICE, bmc: null },
      { name: 'ghost', kind: 'vm', power: 'on', configured: false, deviceId: null, bmc: null },
    ]);
  });

  it('rejects a roster entry that omits the device id', () => {
    const { deviceId: _deviceId, ...noDeviceId } = machine();
    expect(() => listRoute().responses[200].parse([noDeviceId])).toThrow();
  });
});

describe('FleetPlanesSchema', () => {
  it('accepts both planes off or on independently', () => {
    expect(FleetPlanesSchema.parse({ vm: true, baremetal: false })).toEqual({ vm: true, baremetal: false });
    expect(FleetPlanesSchema.parse({ vm: false, baremetal: true })).toEqual({ vm: false, baremetal: true });
    expect(FleetPlanesSchema.parse({ vm: true, baremetal: true })).toEqual({ vm: true, baremetal: true });
    expect(FleetPlanesSchema.parse({ vm: false, baremetal: false })).toEqual({ vm: false, baremetal: false });
  });

  it('rejects a non-boolean plane', () => {
    expect(() => FleetPlanesSchema.parse({ vm: 'yes', baremetal: false })).toThrow();
    expect(() => FleetPlanesSchema.parse({ vm: true })).toThrow();
  });

  it('describes every field', () => {
    for (const [name, field] of Object.entries(FleetPlanesSchema.shape)) {
      expect(field.description, `${name} is missing a describe()`).toBeTruthy();
    }
  });
});

describe('FleetPendingSchema severity', () => {
  const base = {
    inSync: false,
    desiredDigest: 'sha256:x',
    appliedDigest: 'sha256:y',
    appliedAt: 1,
    summary: { added: 0, removed: 0, changed: 0, unchanged: 0 },
    nodes: { added: [], removed: [], changed: [] },
    network: { changed: false, fields: [] },
    note: null,
  };

  it('accepts planes-change', () => {
    expect(FleetPendingSchema.parse({ ...base, severity: 'planes-change' }).severity).toBe('planes-change');
  });

  it('names exactly the five members and rejects anything else', () => {
    expect(FleetPendingSchema.shape.severity.options).toEqual([
      'in-sync',
      'hot-appliable',
      'needs-full-rebuild',
      'planes-change',
      'stale-bake',
    ]);
    expect(() => FleetPendingSchema.parse({ ...base, severity: 'nonsense' })).toThrow();
  });
});

describe('FleetVerifyReportSchema', () => {
  const report = {
    status: 'no-manifest',
    findings: [],
    summary: { checked: 0, ok: 0, findings: 0 },
  };

  it('accepts null planes when no manifest is present', () => {
    expect(FleetVerifyReportSchema.parse({ ...report, planes: null }).planes).toBeNull();
  });

  it('accepts the planes the applied manifest carries', () => {
    expect(
      FleetVerifyReportSchema.parse({ ...report, status: 'healthy', planes: { vm: true, baremetal: true } }).planes,
    ).toEqual({ vm: true, baremetal: true });
  });

  it('accepts a verify report without planes as null', () => {
    expect(FleetVerifyReportSchema.parse(report).planes).toBeNull();
    expect(FleetVerifyReportSchema.parse({ ...report, mode: 'vm' }).planes).toBeNull();
  });

  it('rejects a mode string in place of the planes', () => {
    expect(() => FleetVerifyReportSchema.parse({ ...report, planes: 'vm' })).toThrow();
  });
});
