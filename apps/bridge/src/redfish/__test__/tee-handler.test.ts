import { isRecord } from '@repo/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { JsonRecord } from '../vendor/base/base.js';
import { RedfishDevice } from '../vendor/base/base.js';
import { RedfishTeeHandler } from '../vendor/base/tee.js';
import { DefaultVendorProfile } from '../vendor/base/vendor-profile.js';

interface Harness {
  device: RedfishDevice;
  handler: RedfishTeeHandler;
  patches: JsonRecord[];
}

function build(opts: { biosParams?: JsonRecord; redfishEndpoint?: string; failKey?: string } = {}): Harness {
  const device = new RedfishDevice('job-test', 'dev-1', '192.0.2.10', 'root', 'calvin');
  device.vendor = 'supermicro';
  device.controller = 'bmc';
  device.model = 'x13dei';
  device.redfishEndpoint = opts.redfishEndpoint ?? '/redfish/v1';
  device.biosGetEndpoint = '/redfish/v1/Systems/1/Bios';
  device.biosPatchEndpoint = '/redfish/v1/Systems/1/Bios/SD';
  device.biosParams = opts.biosParams ?? { MemoryEncryption_TME_: 'Disabled', SWGuardExtensions_SGX_: 'Disabled' };
  device.biosRetryAttempts = 1;

  const handler = new RedfishTeeHandler(device, 'job-test');
  const patches: JsonRecord[] = [];
  vi.spyOn(handler, 'fetch').mockImplementation(async (method, endpoint, payload) => {
    const body = method === 'PATCH' ? patchResponse(payload, opts.failKey) : {};
    handler.device.callStack.push({
      method,
      endpoint,
      request: payload,
      response: body,
      responseHeaders: {},
      status: 200,
    });
    if (method === 'PATCH') patches.push(payload);
    return body;
  });
  return { device, handler, patches };
}

function patchResponse(payload: JsonRecord, failKey: string | undefined): JsonRecord {
  const attributes = payload['Attributes'];
  const fails = failKey !== undefined && isRecord(attributes) && failKey in attributes;
  if (fails) {
    return { error: { '@Message.ExtendedInfo': [{ Message: `cannot set ${failKey}`, Resolution: 'None' }] } };
  }
  return { '@Message.ExtendedInfo': [{ Message: 'The request completed successfully.', Resolution: 'None' }] };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('applyTeeStage', () => {
  it('counts one patch per attribute that differed from the live value', async () => {
    const h = build();

    const result = await h.handler.applyTeeStage({
      MemoryEncryption_TME_: 'Enabled',
      SWGuardExtensions_SGX_: 'Enabled',
    });

    expect(result).toEqual({ ok: true, patched: 2 });
    expect(h.patches.map((p) => p['Attributes'])).toEqual([
      { MemoryEncryption_TME_: 'Enabled' },
      { SWGuardExtensions_SGX_: 'Enabled' },
    ]);
  });

  it('reports zero patches when every value is already in place', async () => {
    const h = build();

    const result = await h.handler.applyTeeStage({
      MemoryEncryption_TME_: 'Disabled',
      SWGuardExtensions_SGX_: 'Disabled',
    });

    expect(result).toEqual({ ok: true, patched: 0 });
    expect(h.patches).toEqual([]);
  });

  it('counts only the patches issued by this stage', async () => {
    const h = build();
    await h.handler.applyTeeStage({ MemoryEncryption_TME_: 'Enabled' });

    const result = await h.handler.applyTeeStage({ SWGuardExtensions_SGX_: 'Enabled' });

    expect(result).toEqual({ ok: true, patched: 1 });
    expect(h.device.callStack.filter((entry) => entry.method === 'PATCH')).toHaveLength(2);
  });

  it('reports the failed stage with the patches issued before the failure', async () => {
    const h = build({ failKey: 'SWGuardExtensions_SGX_' });

    const result = await h.handler.applyTeeStage({
      MemoryEncryption_TME_: 'Enabled',
      SWGuardExtensions_SGX_: 'Enabled',
    });

    expect(result).toEqual({ ok: false, patched: 2 });
  });
});

describe('verifyTee reasons', () => {
  it('reports bmc-unreachable when discovery left no redfish endpoint', async () => {
    const h = build({ redfishEndpoint: '' });

    expect(await h.handler.verifyTee()).toEqual({ ok: false, checked: false, missing: [], reason: 'bmc-unreachable' });
  });

  it('reports bmc-unreachable when discovery left no bios attributes', async () => {
    const h = build({ biosParams: {} });

    expect(await h.handler.verifyTee()).toEqual({ ok: false, checked: false, missing: [], reason: 'bmc-unreachable' });
  });

  it('delegates to the vendor profile once discovery produced an endpoint and attributes', async () => {
    const h = build();

    const result = await h.handler.verifyTee();

    expect(result.checked).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('marks the base profile fallback as unmodeled', async () => {
    const h = build();
    h.device.vendor = 'nobody';

    expect(await new DefaultVendorProfile().verifyTee(h.handler)).toEqual({
      ok: true,
      checked: false,
      missing: [],
      reason: 'unmodeled',
    });
  });
});
