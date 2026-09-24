import { describe, expect, it, vi } from 'vitest';

import {
  disableOsBootOptions,
  disableTee,
  enableTee,
  RedfishServiceUnavailableError,
  redfishStandardize,
  verifyTee,
  type RedfishOperationsDeps,
  type RedfishTeeCapableService,
} from '../redfish-operations.js';

const ARGS = ['device-1', '10.0.0.5', 'admin', 'secret', 'job-abc'] as const;

describe('redfish-operations — unwired service throws', () => {
  it('disableTee throws RedfishServiceUnavailableError when createRedfishService is missing', async () => {
    await expect(disableTee(...ARGS)).rejects.toThrowError(RedfishServiceUnavailableError);
    await expect(disableTee(...ARGS)).rejects.toThrowError(/disableTee/);
  });

  it('enableTee throws RedfishServiceUnavailableError when createRedfishService is missing', async () => {
    await expect(enableTee(...ARGS)).rejects.toThrowError(RedfishServiceUnavailableError);
    await expect(enableTee(...ARGS)).rejects.toThrowError(/enableTee/);
  });

  it('disableOsBootOptions throws RedfishServiceUnavailableError when createRedfishService is missing', async () => {
    await expect(disableOsBootOptions(...ARGS)).rejects.toThrowError(RedfishServiceUnavailableError);
    await expect(disableOsBootOptions(...ARGS)).rejects.toThrowError(/disableOsBootOptions/);
  });

  it('verifyTee throws RedfishServiceUnavailableError when createRedfishService is missing', async () => {
    await expect(verifyTee(...ARGS)).rejects.toThrowError(RedfishServiceUnavailableError);
    await expect(verifyTee(...ARGS)).rejects.toThrowError(/verifyTee/);
  });

  it('redfishStandardize throws when neither createRedfishService nor standardizeHandlers are wired', async () => {
    await expect(redfishStandardize(...ARGS)).rejects.toThrowError(RedfishServiceUnavailableError);
    await expect(redfishStandardize(...ARGS)).rejects.toThrowError(/redfishStandardize/);
  });

  it('explicit empty deps object still throws (no silent no-op on default-arg fall-through)', async () => {
    const deps: RedfishOperationsDeps = {};
    await expect(disableTee(...ARGS, deps)).rejects.toThrowError(RedfishServiceUnavailableError);
    await expect(enableTee(...ARGS, deps)).rejects.toThrowError(RedfishServiceUnavailableError);
    await expect(disableOsBootOptions(...ARGS, deps)).rejects.toThrowError(RedfishServiceUnavailableError);
    await expect(verifyTee(...ARGS, deps)).rejects.toThrowError(RedfishServiceUnavailableError);
    await expect(redfishStandardize(...ARGS, deps)).rejects.toThrowError(RedfishServiceUnavailableError);
  });
});

describe('redfish-operations — wired service still works end-to-end (no regression on the happy path)', () => {
  function makeWiredService(): RedfishTeeCapableService {
    return {
      setTee: vi.fn().mockResolvedValue(true),
      verifyTee: vi.fn().mockResolvedValue({ ok: true, checked: true, missing: [] }),
      reliableBoot: vi.fn().mockResolvedValue({ ok: true }),
    };
  }

  it('disableTee reports success and invokes setTee(_, false)', async () => {
    const service = makeWiredService();
    const result = await disableTee(...ARGS, { createRedfishService: async () => service });
    expect(result).toEqual({ success: true, hostResetAt: null });
    expect(service.setTee).toHaveBeenCalledTimes(1);
    expect(service.setTee).toHaveBeenCalledWith(expect.anything(), false);
  });

  it('enableTee reports success and invokes setTee(_, true)', async () => {
    const service = makeWiredService();
    const result = await enableTee(...ARGS, { createRedfishService: async () => service });
    expect(result).toEqual({ success: true, hostResetAt: null });
    expect(service.setTee).toHaveBeenCalledWith(expect.anything(), true);
  });

  it('enableTee reports failure when setTee reports failure', async () => {
    const service = makeWiredService();
    vi.mocked(service.setTee).mockResolvedValue(false);
    const result = await enableTee(...ARGS, { createRedfishService: async () => service });
    expect(result).toEqual({ success: false, hostResetAt: null });
  });

  it('enableTee reports the host reset time the fence recorded on the device', async () => {
    const service = makeWiredService();
    vi.mocked(service.setTee).mockImplementation(async (device) => {
      device.lastHostResetAt = 1_726_000_000;
      return true;
    });
    const result = await enableTee(...ARGS, { createRedfishService: async () => service });
    expect(result).toEqual({ success: true, hostResetAt: 1_726_000_000 });
  });

  it('disableTee keeps the host reset time when setTee throws after the fence', async () => {
    const service = makeWiredService();
    vi.mocked(service.setTee).mockImplementation(async (device) => {
      device.lastHostResetAt = 1_726_000_000;
      throw new Error('bios never settled');
    });
    const result = await disableTee(...ARGS, { createRedfishService: async () => service });
    expect(result).toEqual({ success: false, hostResetAt: 1_726_000_000 });
  });

  it('disableOsBootOptions returns true and invokes reliableBoot', async () => {
    const service = makeWiredService();
    const result = await disableOsBootOptions(...ARGS, { createRedfishService: async () => service });
    expect(result).toBe(true);
    expect(service.reliableBoot).toHaveBeenCalledTimes(1);
  });

  it('verifyTee returns the structured result from the wired service', async () => {
    const service = makeWiredService();
    const result = await verifyTee(...ARGS, { createRedfishService: async () => service });
    expect(result).toEqual({ ok: true, checked: true, missing: [] });
    expect(service.verifyTee).toHaveBeenCalledTimes(1);
  });

  it('disableTee reports failure when the wired service throws (existing catch path is preserved)', async () => {
    const service: RedfishTeeCapableService = {
      setTee: vi.fn().mockRejectedValue(new Error('BMC unreachable')),
      verifyTee: vi.fn(),
      reliableBoot: vi.fn(),
    };
    const result = await disableTee(...ARGS, { createRedfishService: async () => service });
    expect(result).toEqual({ success: false, hostResetAt: null });
  });

  it('verifyTee reports an unreachable bmc instead of a verified negative when the Redfish service throws', async () => {
    const service: RedfishTeeCapableService = {
      setTee: vi.fn(),
      verifyTee: vi.fn().mockRejectedValue(new Error('BMC unreachable')),
      reliableBoot: vi.fn(),
    };
    const result = await verifyTee(...ARGS, { createRedfishService: async () => service });
    expect(result).toEqual({ ok: false, checked: false, missing: [], reason: 'bmc-unreachable' });
  });

  it('redfishStandardize re-throws when the wired discovery handler rejects', async () => {
    const error = new Error('BMC discover failed');
    const deps: RedfishOperationsDeps = {
      createRedfishService: async () => makeWiredService(),
      standardizeHandlers: {
        createDiscoveryHandler: () => ({ discover: vi.fn().mockRejectedValue(error) }),
        createBootHandler: () => ({ discover: vi.fn(), reliableBoot: vi.fn() }),
      },
    };
    await expect(redfishStandardize(...ARGS, deps)).rejects.toThrowError('BMC discover failed');
  });

  it('redfishStandardize re-throws when the wired boot handler reliableBoot rejects', async () => {
    const error = new Error('BMC reliableBoot failed');
    const deps: RedfishOperationsDeps = {
      createRedfishService: async () => makeWiredService(),
      standardizeHandlers: {
        createDiscoveryHandler: () => ({ discover: vi.fn().mockResolvedValue(undefined) }),
        createBootHandler: () => ({
          discover: vi.fn().mockResolvedValue(undefined),
          reliableBoot: vi.fn().mockRejectedValue(error),
        }),
      },
    };
    await expect(redfishStandardize(...ARGS, deps)).rejects.toThrowError('BMC reliableBoot failed');
  });
});
