import { afterEach, describe, expect, it, vi } from 'vitest';

import type { JsonRecord } from '../vendor/base/base.js';
import { RedfishDevice } from '../vendor/base/base.js';
import { RedfishPowerHandler } from '../vendor/base/power.js';
import { RedfishDellHandler } from '../vendor/dell/dell.js';

interface FetchCall {
  method: string;
  endpoint: string;
  payload: JsonRecord;
}

interface Harness {
  device: RedfishDevice;
  handler: RedfishPowerHandler;
  queue: (response: JsonRecord) => void;
  calls: FetchCall[];
}

interface DeviceOptions {
  vendor: string;
  controller: string;
  model: string;
  rebootEndpoint?: string;
  chassisEndpoint?: string;
  systemEndpoint?: string;
  bootState?: string;
  bootOptions?: string[];
}

function buildHarness(opts: DeviceOptions): Harness {
  const device = new RedfishDevice('job-test', 'dev-1', '192.0.2.10', 'root', 'calvin');
  device.vendor = opts.vendor;
  device.controller = opts.controller;
  device.model = opts.model;
  device.rebootEndpoint = opts.rebootEndpoint ?? '/redfish/v1/Managers/1/Actions/Manager.Reset';
  device.chassisEndpoint = opts.chassisEndpoint ?? '/redfish/v1/Chassis/1';
  device.systemEndpoint = opts.systemEndpoint ?? '/redfish/v1/Systems/1';
  device.biosPatchEndpoint = '/redfish/v1/Systems/1/Bios/Settings';
  device.bootState = opts.bootState ?? 'On';
  device.bootOptions = opts.bootOptions ?? [];
  device.rebootTimeout = 0;
  device.rebootWaits = 3;

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

describe('aivres/supermicro reboot', () => {
  it('boot_state=Off uses ResetType=On and clears reboot_needed on clean pending', async () => {
    const h = buildHarness({ vendor: 'aivres', controller: 'bmc', model: 'kr6288', bootState: 'Off' });
    h.device.rebootNeeded = true;
    h.queue({});
    h.queue({ PowerState: 'On' });
    h.queue({ Attributes: {} });

    await h.handler.reboot();

    expect(h.calls[0]?.method).toBe('POST');
    expect(h.calls[0]?.endpoint).toBe(h.device.rebootEndpoint);
    expect(h.calls[0]?.payload).toEqual({ ResetType: 'On' });
    expect(h.device.rebootNeeded).toBe(false);
  });

  it('boot_state=On uses ResetType=ForceRestart for supermicro', async () => {
    const h = buildHarness({ vendor: 'supermicro', controller: 'bmc', model: 'x12dpi', bootState: 'On' });
    h.queue({});
    h.queue({ PowerState: 'On' });
    h.queue({ Attributes: {} });

    await h.handler.reboot();

    expect(h.calls[0]?.payload).toEqual({ ResetType: 'ForceRestart' });
  });

  it('waits for PowerState to become On across multiple polls', async () => {
    const h = buildHarness({ vendor: 'aivres', controller: 'bmc', model: 'kr6288', bootState: 'On' });
    h.device.rebootWaits = 5;
    h.queue({});
    h.queue({ PowerState: 'Off' });
    h.queue({ PowerState: 'PoweringOn' });
    h.queue({ PowerState: 'On' });
    h.queue({ Attributes: {} });

    await h.handler.reboot();

    expect(h.calls.length).toBe(5);
    expect(h.device.rebootNeeded).toBe(false);
  });

  it('clears reboot_needed once BIOS attributes drain', async () => {
    const h = buildHarness({ vendor: 'aivres', controller: 'bmc', model: 'kr6288', bootState: 'On' });
    h.device.rebootWaits = 3;
    h.queue({});
    h.queue({ PowerState: 'On' });
    h.queue({ Attributes: { Hyperthreading: 'Enabled' } });
    h.queue({ Attributes: {} });

    await h.handler.reboot();

    expect(h.device.rebootNeeded).toBe(false);
  });

  it('BIOS pending loop exhausts and leaves reboot_needed unchanged', async () => {
    const h = buildHarness({ vendor: 'aivres', controller: 'bmc', model: 'kr6288', bootState: 'On' });
    h.device.rebootWaits = 2;
    h.device.rebootNeeded = true;
    h.queue({});
    h.queue({ PowerState: 'On' });
    h.queue({ Attributes: { X: 1 } });
    h.queue({ Attributes: { X: 1 } });

    await h.handler.reboot();

    expect(h.device.rebootNeeded).toBe(true);
  });
});

describe('lenovo reboot', () => {
  it('prefers GracefulRestart when available', async () => {
    const h = buildHarness({
      vendor: 'lenovo',
      controller: 'xcc3',
      model: 'sr650v3',
      bootOptions: ['GracefulRestart', 'ForceRestart', 'On', 'Nmi', 'ForceOff'],
    });
    h.queue({});
    h.queue({ PowerState: 'On', Status: { Health: 'OK' }, LastResetTime: '2024-06-01T12:00:00+00:00' });

    await h.handler.reboot();

    expect(h.calls[0]?.payload).toEqual({ ResetType: 'GracefulRestart' });
    expect(h.calls[0]?.endpoint).toBe(h.device.rebootEndpoint);
    expect(h.device.rebootNeeded).toBe(false);
  });

  it('falls back to ForceRestart when Graceful unavailable', async () => {
    const h = buildHarness({
      vendor: 'lenovo',
      controller: 'xcc3',
      model: 'sr650v3',
      bootOptions: ['ForceRestart', 'On', 'Nmi', 'PushPowerButton'],
    });
    h.queue({});
    h.queue({ PowerState: 'On', Status: { Health: 'OK' }, LastResetTime: '2024-06-01T12:00:00+00:00' });

    await h.handler.reboot();

    expect(h.calls[0]?.payload).toEqual({ ResetType: 'ForceRestart' });
  });

  it('no supported restart option logs and returns without fetch', async () => {
    const h = buildHarness({
      vendor: 'lenovo',
      controller: 'xcc3',
      model: 'sr650v3',
      bootOptions: ['On', 'ForceOff', 'Nmi', 'PowerCycle', 'PushPowerButton'],
    });
    h.device.rebootNeeded = true;

    await h.handler.reboot();

    expect(h.calls.length).toBe(0);
    expect(h.device.rebootNeeded).toBe(true);
  });

  it('monitor loop exhausts when PowerState never reports On', async () => {
    const h = buildHarness({
      vendor: 'lenovo',
      controller: 'xcc3',
      model: 'sr650v3',
      bootOptions: ['GracefulRestart'],
    });
    h.device.rebootWaits = 2;
    h.device.rebootNeeded = true;
    h.queue({});
    h.queue({ PowerState: 'Off' });
    h.queue({ PowerState: 'Off' });

    await h.handler.reboot();

    expect(h.device.rebootNeeded).toBe(true);
  });
});

describe('unsupported vendor reboot', () => {
  it('unknown vendor logs and returns without fetch', async () => {
    const h = buildHarness({
      vendor: 'hpe',
      controller: 'ilo5',
      model: 'dl380',
      rebootEndpoint: '/redfish/v1/Systems/1/Actions/ComputerSystem.Reset',
    });
    h.device.rebootNeeded = true;

    await h.handler.reboot();

    expect(h.calls.length).toBe(0);
    expect(h.device.rebootNeeded).toBe(true);
  });
});

describe('dell reboot delegation', () => {
  it('routes reboot() into the BIOS config-job lifecycle for a dell.idrac9 tag', async () => {
    const lifecycle = vi.spyOn(RedfishDellHandler.prototype, 'runBiosConfigLifecycle').mockResolvedValue(undefined);
    const h = buildHarness({ vendor: 'dell', controller: 'idrac9', model: 'poweredge' });
    h.device.biosPendingParams = { EnableTdx: 'Enabled' };

    await h.handler.reboot();

    expect(lifecycle).toHaveBeenCalledTimes(1);
    const dellHandler = lifecycle.mock.instances[0];
    expect(dellHandler).toBeInstanceOf(RedfishDellHandler);
    if (dellHandler instanceof RedfishDellHandler) {
      expect(dellHandler.device).toBe(h.device);
    }
    expect(h.calls.length).toBe(0);
  });
});
