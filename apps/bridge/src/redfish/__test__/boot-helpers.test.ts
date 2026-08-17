import { afterEach, describe, expect, it, vi } from 'vitest';

import type { JsonRecord } from '../vendor/base/base.js';
import { PropertyAccessError, RedfishDevice, UninitializedVariableError } from '../vendor/base/base.js';
import { RedfishBootHandler } from '../vendor/base/boot.js';
import { RedfishPowerHandler } from '../vendor/base/power.js';
import { pollResetRebootWithPendingBios } from '../vendor/base/reboot-helpers.js';

interface FetchCall {
  method: string;
  endpoint: string;
  payload: JsonRecord;
}

interface BootHarness {
  device: RedfishDevice;
  handler: RedfishBootHandler;
  queue: (response: JsonRecord) => void;
  calls: FetchCall[];
}

function buildBootHarness(vendor = 'dell', controller = 'idrac9', model = 'r740'): BootHarness {
  const device = new RedfishDevice('test-job', 'dev-1', '10.0.0.1', 'root', 'pw');
  device.vendor = vendor;
  device.controller = controller;
  device.model = model;
  device.systemEndpoint = '/redfish/v1/Systems/System.Embedded.1';
  device.managerEndpoint = '/redfish/v1/Managers/iDRAC.Embedded.1';
  device.chassisEndpoint = '/redfish/v1/Chassis/System.Embedded.1';
  device.biosPatchEndpoint = '/redfish/v1/Systems/System.Embedded.1/Bios/Settings';
  device.rebootEndpoint = '/redfish/v1/Systems/System.Embedded.1/Actions/ComputerSystem.Reset';
  device.rebootWaits = 3;
  device.rebootTimeout = 0;

  const handler = new RedfishBootHandler(device, 'test-job');
  const queued: JsonRecord[] = [];
  const calls: FetchCall[] = [];
  vi.spyOn(handler, 'fetch').mockImplementation(async (method, endpoint, payload) => {
    calls.push({ method, endpoint, payload });
    return queued.shift() ?? {};
  });
  return { device, handler, queue: (r) => queued.push(r), calls };
}

interface PowerHarness {
  device: RedfishDevice;
  handler: RedfishPowerHandler;
  queue: (response: JsonRecord) => void;
  calls: FetchCall[];
}

function buildPowerHarness(opts: {
  vendor: string;
  controller: string;
  model: string;
  bootState?: string;
  rebootWaits?: number;
}): PowerHarness {
  const device = new RedfishDevice('job-test', 'dev-1', '192.0.2.10', 'root', 'calvin');
  device.vendor = opts.vendor;
  device.controller = opts.controller;
  device.model = opts.model;
  device.rebootEndpoint = '/redfish/v1/Systems/1/Actions/ComputerSystem.Reset';
  device.chassisEndpoint = '/redfish/v1/Chassis/1';
  device.systemEndpoint = '/redfish/v1/Systems/1';
  device.biosPatchEndpoint = '/redfish/v1/Systems/1/Bios/Settings';
  device.bootState = opts.bootState ?? 'On';
  device.rebootTimeout = 0;
  device.rebootWaits = opts.rebootWaits ?? 3;

  const handler = new RedfishPowerHandler(device, 'job-test');
  const queued: JsonRecord[] = [];
  const calls: FetchCall[] = [];
  vi.spyOn(handler, 'fetch').mockImplementation(async (method, endpoint, payload) => {
    calls.push({ method, endpoint, payload });
    return queued.shift() ?? {};
  });
  return { device, handler, queue: (r) => queued.push(r), calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('filterLinkUpEthernetInterfaces (via findActiveInterfaces)', () => {
  it('fetches parentEndpoint first, then follows EthernetInterfaces with $expand appended', async () => {
    const h = buildBootHarness('dell', 'idrac9', 'r740');
    h.queue({ EthernetInterfaces: { '@odata.id': '/redfish/v1/Systems/1/EthernetInterfaces' } });
    h.queue({ Members: [] });

    await h.handler.findActiveInterfaces();

    expect(h.calls.length).toBe(2);
    expect(h.calls[0]?.method).toBe('GET');
    expect(h.calls[0]?.endpoint).toBe(h.device.systemEndpoint);
    expect(h.calls[1]?.method).toBe('GET');
    expect(h.calls[1]?.endpoint).toBe('/redfish/v1/Systems/1/EthernetInterfaces?$expand=*($levels=1)');
  });

  it('returns only Members with LinkStatus === "LinkUp"', async () => {
    const h = buildBootHarness('dell', 'idrac9', 'r740');
    h.queue({ EthernetInterfaces: { '@odata.id': '/redfish/v1/Systems/1/EthernetInterfaces' } });
    h.queue({
      Members: [
        { LinkStatus: 'LinkUp', Id: 'NIC.1' },
        { LinkStatus: 'LinkDown', Id: 'NIC.2' },
        { LinkStatus: 'LinkUp', Id: 'NIC.3' },
      ],
    });

    const result = await h.handler.findActiveInterfaces();

    expect(result.map((m) => m['Id'])).toEqual(['NIC.1', 'NIC.3']);
  });

  it('filters out members with missing LinkStatus', async () => {
    const h = buildBootHarness('dell', 'idrac9', 'r740');
    h.queue({ EthernetInterfaces: { '@odata.id': '/redfish/v1/Systems/1/EthernetInterfaces' } });
    h.queue({
      Members: [{ Id: 'NIC.NoStatus' }, { LinkStatus: 'LinkUp', Id: 'NIC.Good' }],
    });

    const result = await h.handler.findActiveInterfaces();

    expect(result.map((m) => m['Id'])).toEqual(['NIC.Good']);
  });

  it('returns [] when Members is absent from the response', async () => {
    const h = buildBootHarness('dell', 'idrac9', 'r740');
    h.queue({ EthernetInterfaces: { '@odata.id': '/redfish/v1/Systems/1/EthernetInterfaces' } });
    h.queue({});

    const result = await h.handler.findActiveInterfaces();

    expect(result).toEqual([]);
  });

  it('rejects with PropertyAccessError when Members is explicitly null', async () => {
    const h = buildBootHarness('dell', 'idrac9', 'r740');
    h.queue({ EthernetInterfaces: { '@odata.id': '/redfish/v1/Systems/1/EthernetInterfaces' } });
    h.queue({ Members: null });

    await expect(h.handler.findActiveInterfaces()).rejects.toBeInstanceOf(PropertyAccessError);
  });

  it('returns [] when EthernetInterfaces key is absent from parentEndpoint response', async () => {
    const h = buildBootHarness('dell', 'idrac9', 'r740');
    h.queue({});

    const result = await h.handler.findActiveInterfaces();

    expect(result).toEqual([]);
  });
});

describe('findActiveInterfaces endpoint invariant', () => {
  it('dell idrac9 fetches the systemEndpoint as the parent', async () => {
    const h = buildBootHarness('dell', 'idrac9', 'r740');
    h.device.systemEndpoint = '/redfish/v1/Systems/System.Embedded.1';
    h.device.managerEndpoint = '/redfish/v1/Managers/iDRAC.Embedded.1';
    h.queue({ EthernetInterfaces: { '@odata.id': '/redfish/v1/Systems/1/EthernetInterfaces' } });
    h.queue({ Members: [] });

    await h.handler.findActiveInterfaces();

    expect(h.calls[0]?.endpoint).toBe('/redfish/v1/Systems/System.Embedded.1');
    expect(h.calls[0]?.endpoint).not.toBe('/redfish/v1/Managers/iDRAC.Embedded.1');
  });

  it('cisco cbmc fetches the managerEndpoint as the parent', async () => {
    const h = buildBootHarness('cisco', 'cbmc', 'cai-845a');
    h.device.systemEndpoint = '/redfish/v1/Systems/FCH1234/';
    h.device.managerEndpoint = '/redfish/v1/Managers/CIMC';
    h.queue({ EthernetInterfaces: { '@odata.id': '/redfish/v1/Managers/CIMC/EthernetInterfaces' } });
    h.queue({ Members: [] });

    await h.handler.findActiveInterfaces();

    expect(h.calls[0]?.endpoint).toBe('/redfish/v1/Managers/CIMC');
    expect(h.calls[0]?.endpoint).not.toBe('/redfish/v1/Systems/FCH1234/');
  });

  it('swapping dell endpoints to managerEndpoint would break the invariant (regression guard)', async () => {
    const h = buildBootHarness('dell', 'idrac9', 'r740');
    h.device.systemEndpoint = '/redfish/v1/Systems/SYSTEM';
    h.device.managerEndpoint = '/redfish/v1/Managers/MANAGER';
    h.queue({ EthernetInterfaces: { '@odata.id': '/redfish/v1/Systems/1/EthernetInterfaces' } });
    h.queue({ Members: [] });

    await h.handler.findActiveInterfaces();

    expect(h.calls[0]?.endpoint).toBe('/redfish/v1/Systems/SYSTEM');
    expect(h.calls[0]?.endpoint).not.toBe('/redfish/v1/Managers/MANAGER');
  });
});

describe('patchStandardPxeBootOverride (via setBootPxe)', () => {
  it('issues a PATCH to systemEndpoint with the correct Boot object for dell', async () => {
    const h = buildBootHarness('dell', 'idrac9', 'r740');

    await h.handler.setBootPxe();

    const patch = h.calls.find((c) => c.method === 'PATCH');
    expect(patch).toBeDefined();
    expect(patch?.endpoint).toBe(h.device.systemEndpoint);
    const boot = patch?.payload['Boot'] as JsonRecord | undefined;
    expect(boot).toBeDefined();
    expect(boot?.['BootSourceOverrideTarget']).toBe('Pxe');
    expect(boot?.['BootSourceOverrideEnabled']).toBe('Continuous');
    expect(boot?.['BootSourceOverrideMode']).toBe('UEFI');
  });

  it('issues a PATCH to systemEndpoint with the correct Boot object for supermicro', async () => {
    const h = buildBootHarness('supermicro', 'aspeed', 'x12dpi');

    await h.handler.setBootPxe();

    const patch = h.calls.find((c) => c.method === 'PATCH');
    expect(patch).toBeDefined();
    expect(patch?.endpoint).toBe(h.device.systemEndpoint);
    const boot = patch?.payload['Boot'] as JsonRecord | undefined;
    expect(boot?.['BootSourceOverrideTarget']).toBe('Pxe');
    expect(boot?.['BootSourceOverrideEnabled']).toBe('Continuous');
    expect(boot?.['BootSourceOverrideMode']).toBe('UEFI');
  });
});

describe('pollResetRebootWithPendingBios rebootWaits=0', () => {
  it('still issues the reset POST to rebootEndpoint before throwing UninitializedVariableError', async () => {
    const h = buildPowerHarness({
      vendor: 'aivres',
      controller: 'bmc',
      model: 'kr6288',
      bootState: 'On',
      rebootWaits: 0,
    });

    let thrown: unknown;
    try {
      await pollResetRebootWithPendingBios(h.handler);
    } catch (err) {
      thrown = err;
    }

    expect(h.calls.length).toBeGreaterThanOrEqual(1);
    expect(h.calls[0]?.method).toBe('POST');
    expect(h.calls[0]?.endpoint).toBe(h.device.rebootEndpoint);

    expect(thrown).toBeInstanceOf(UninitializedVariableError);
    expect((thrown as UninitializedVariableError).name).toBe('UninitializedVariableError');
  });
});
