import { afterEach, describe, expect, it, vi } from 'vitest';

import type { JsonRecord } from '../vendor/base/base.js';
import { rebootBudget, RedfishDevice } from '../vendor/base/base.js';
import { RedfishPowerHandler } from '../vendor/base/power.js';
import { BiosSettleTimeoutError, pollResetRebootUntilBiosSettled } from '../vendor/base/reboot-helpers.js';

interface FetchCall {
  method: string;
  endpoint: string;
  payload: JsonRecord;
}

interface Harness {
  device: RedfishDevice;
  handler: RedfishPowerHandler;
  queue: (...responses: JsonRecord[]) => void;
  calls: FetchCall[];
}

const LIVE = { MemoryEncryption_TME_: 'Disabled', TrustDomainExtensions_TDX_: 'Disabled', SGX: 'Disabled' };
const LIVE_APPLIED = { ...LIVE, MemoryEncryption_TME_: 'Enabled' };
const SD_PATCHED = { ...LIVE, MemoryEncryption_TME_: 'Enabled' };

function attributes(map: JsonRecord): JsonRecord {
  return { Attributes: map };
}

function build(opts: { bootState?: string; rebootWaits?: number; biosPendingParams?: JsonRecord } = {}): Harness {
  const device = new RedfishDevice('job-test', 'dev-1', '192.0.2.10', 'root', 'calvin');
  device.vendor = 'supermicro';
  device.controller = 'bmc';
  device.model = 'sys-222ha-tn';
  device.rebootEndpoint = '/redfish/v1/Systems/1/Actions/ComputerSystem.Reset';
  device.chassisEndpoint = '/redfish/v1/Chassis/1';
  device.biosGetEndpoint = '/redfish/v1/Systems/1/Bios';
  device.biosPatchEndpoint = '/redfish/v1/Systems/1/Bios/SD';
  device.bootState = opts.bootState ?? 'On';
  device.rebootTimeout = 0;
  device.rebootWaits = opts.rebootWaits ?? 3;
  device.rebootNeeded = true;
  device.biosParams = { ...LIVE };
  device.biosPendingParams = opts.biosPendingParams ?? { ...SD_PATCHED };

  const handler = new RedfishPowerHandler(device, 'job-test');
  const queued: JsonRecord[] = [];
  const calls: FetchCall[] = [];
  vi.spyOn(handler, 'fetch').mockImplementation(async (method, endpoint, payload) => {
    calls.push({ method, endpoint, payload });
    return method === 'GET' ? (queued.shift() ?? {}) : {};
  });
  return { device, handler, queue: (...responses) => queued.push(...responses), calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('pollResetRebootUntilBiosSettled', () => {
  it('force-restarts a powered-on host and powers on a powered-off one', async () => {
    const on = build();
    on.queue(attributes(LIVE), attributes(LIVE));
    await pollResetRebootUntilBiosSettled(on.handler);
    expect(on.calls[0]).toEqual({
      method: 'POST',
      endpoint: on.device.rebootEndpoint,
      payload: { ResetType: 'ForceRestart' },
    });

    const off = build({ bootState: 'Off' });
    off.queue(attributes(LIVE), attributes(LIVE));
    await pollResetRebootUntilBiosSettled(off.handler);
    expect(off.calls[0]?.payload).toEqual({ ResetType: 'On' });
  });

  it('treats an SD that echoes the full live map as settled', async () => {
    const h = build();
    h.queue(attributes(LIVE_APPLIED), attributes(LIVE_APPLIED));

    await pollResetRebootUntilBiosSettled(h.handler);

    expect(h.calls.map((c) => [c.method, c.endpoint])).toEqual([
      ['POST', h.device.rebootEndpoint],
      ['GET', h.device.biosGetEndpoint],
      ['GET', h.device.biosPatchEndpoint],
    ]);
    expect(h.device.biosParams).toEqual(LIVE_APPLIED);
    expect(h.device.biosPendingParams).toEqual({});
    expect(h.device.rebootNeeded).toBe(false);
  });

  it('treats an empty SD as settled', async () => {
    const h = build();
    h.queue(attributes(LIVE_APPLIED), attributes({}));

    await pollResetRebootUntilBiosSettled(h.handler);

    expect(h.device.biosParams).toEqual(LIVE_APPLIED);
    expect(h.device.biosPendingParams).toEqual({});
    expect(h.device.rebootNeeded).toBe(false);
  });

  it('keeps polling while the SD differs from live and refreshes from the settled documents', async () => {
    const h = build();
    h.queue(attributes(LIVE), attributes(SD_PATCHED));
    h.queue(attributes(LIVE), attributes(SD_PATCHED));
    h.queue(attributes(LIVE_APPLIED), attributes(SD_PATCHED));

    await pollResetRebootUntilBiosSettled(h.handler);

    expect(h.calls.filter((c) => c.method === 'GET' && c.endpoint === h.device.biosPatchEndpoint)).toHaveLength(3);
    expect(h.device.biosParams).toEqual(LIVE_APPLIED);
    expect(h.device.biosPendingParams).toEqual({});
    expect(h.device.rebootNeeded).toBe(false);
  });

  it('does not settle on a BMC that returns no live attributes', async () => {
    const h = build();
    h.queue({}, attributes({}));
    h.queue({ error: { code: 'Base.1.0.GeneralError' } }, attributes({}));
    h.queue(attributes(LIVE_APPLIED), attributes(SD_PATCHED));

    await pollResetRebootUntilBiosSettled(h.handler);

    expect(h.calls.filter((c) => c.method === 'GET')).toHaveLength(6);
    expect(h.device.biosParams).toEqual(LIVE_APPLIED);
  });

  it('fails hard with the pending keys when the budget runs out', async () => {
    const h = build({ rebootWaits: 2 });
    h.queue(attributes(LIVE), attributes(SD_PATCHED));
    h.queue(attributes(LIVE), attributes(SD_PATCHED));

    await expect(pollResetRebootUntilBiosSettled(h.handler)).rejects.toThrow(BiosSettleTimeoutError);
    expect(h.calls.filter((c) => c.method === 'GET')).toHaveLength(4);
    expect(h.device.rebootNeeded).toBe(true);
    expect(h.device.biosParams).toEqual(LIVE);
    expect(h.device.biosPendingParams).toEqual(SD_PATCHED);
  });

  it('names the unreadable BMC when no poll returned live attributes', async () => {
    const h = build({ rebootWaits: 2 });

    await expect(pollResetRebootUntilBiosSettled(h.handler)).rejects.toThrow(/not readable within 0s/);
  });

  it('names the still-pending keys in the timeout error', async () => {
    const h = build({ rebootWaits: 1 });
    h.queue(attributes(LIVE), attributes(SD_PATCHED));

    await expect(pollResetRebootUntilBiosSettled(h.handler)).rejects.toThrow(/MemoryEncryption_TME_/);
  });

  it('polls exactly rebootWaits times before giving up', async () => {
    const h = build({ rebootWaits: 5 });

    await expect(pollResetRebootUntilBiosSettled(h.handler)).rejects.toThrow(BiosSettleTimeoutError);
    expect(h.calls.filter((c) => c.method === 'GET' && c.endpoint === h.device.biosGetEndpoint)).toHaveLength(5);
  });
});

describe('rebootBudget', () => {
  it('defaults to 15 waits of 45 seconds', () => {
    expect(rebootBudget({})).toEqual({ waits: 15, timeoutS: 45 });
  });

  it('reads REDFISH_REBOOT_WAITS and REDFISH_REBOOT_TIMEOUT_S', () => {
    expect(rebootBudget({ REDFISH_REBOOT_WAITS: '30', REDFISH_REBOOT_TIMEOUT_S: '60' })).toEqual({
      waits: 30,
      timeoutS: 60,
    });
  });

  it('overrides one side independently of the other', () => {
    expect(rebootBudget({ REDFISH_REBOOT_WAITS: '20' })).toEqual({ waits: 20, timeoutS: 45 });
    expect(rebootBudget({ REDFISH_REBOOT_TIMEOUT_S: '90' })).toEqual({ waits: 15, timeoutS: 90 });
  });

  it('rejects a value that is not a whole number', () => {
    expect(() => rebootBudget({ REDFISH_REBOOT_WAITS: '1.5' })).toThrow();
    expect(() => rebootBudget({ REDFISH_REBOOT_TIMEOUT_S: 'soon' })).toThrow();
    expect(() => rebootBudget({ REDFISH_REBOOT_WAITS: '' })).toThrow();
  });

  it('seeds a new RedfishDevice from the environment', () => {
    const saved = { waits: process.env.REDFISH_REBOOT_WAITS, timeoutS: process.env.REDFISH_REBOOT_TIMEOUT_S };
    process.env.REDFISH_REBOOT_WAITS = '25';
    process.env.REDFISH_REBOOT_TIMEOUT_S = '75';
    try {
      const device = new RedfishDevice('job-1', 'dev-1', '1.2.3.4');
      expect(device.rebootWaits).toBe(25);
      expect(device.rebootTimeout).toBe(75);
    } finally {
      if (saved.waits === undefined) delete process.env.REDFISH_REBOOT_WAITS;
      else process.env.REDFISH_REBOOT_WAITS = saved.waits;
      if (saved.timeoutS === undefined) delete process.env.REDFISH_REBOOT_TIMEOUT_S;
      else process.env.REDFISH_REBOOT_TIMEOUT_S = saved.timeoutS;
    }
    expect(new RedfishDevice('job-1', 'dev-1', '1.2.3.4')).toMatchObject({ rebootWaits: 15, rebootTimeout: 45 });
  });
});
