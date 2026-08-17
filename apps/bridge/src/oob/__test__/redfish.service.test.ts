import { describe, expect, it, vi } from 'vitest';

import { RedfishDevice } from '../../redfish/index.js';
import { RedfishService } from '../redfish.service.js';

function makeDevice(): RedfishDevice {
  return new RedfishDevice('job-1', 'dev-1', '10.0.0.9', 'root', 'calvin');
}

describe('RedfishService', () => {
  it('exposes the redfish command surface', () => {
    const service = new RedfishService('job-1');
    expect(service.hasCommand('reliable_boot')).toBe(true);
    expect(service.hasCommand('bios_attributes')).toBe(true);
    expect(service.hasCommand('set_tee')).toBe(true);
    expect(service.hasCommand('verify_tee')).toBe(true);
    expect(service.hasCommand('explode')).toBe(false);
  });

  it('reliable_boot discovers then sets up reliable boot', async () => {
    const order: string[] = [];
    const service = new RedfishService('job-1', {
      bootHandlerFactory: () => ({
        discover: async () => {
          order.push('discover');
        },
        reliableBoot: async () => {
          order.push('reliableBoot');
        },
      }),
    });

    const out = await service.execute('reliable_boot', makeDevice());

    expect(out).toEqual({ success: true });
    expect(order).toEqual(['discover', 'reliableBoot']);
  });

  it('bios_attributes returns current params by default', async () => {
    const device = makeDevice();
    device.biosParams = { BootMode: 'Uefi' };
    device.biosPendingParams = { BootMode: 'Bios' };
    const service = new RedfishService('job-1', {
      discoveryHandlerFactory: () => ({ device, discover: vi.fn().mockResolvedValue(undefined) }),
    });

    expect(await service.execute('bios_attributes', device)).toEqual({ bios_attributes: { BootMode: 'Uefi' } });
  });

  it('bios_attributes returns pending params when requested', async () => {
    const device = makeDevice();
    device.biosParams = { BootMode: 'Uefi' };
    device.biosPendingParams = { BootMode: 'Bios' };
    const service = new RedfishService('job-1', {
      discoveryHandlerFactory: () => ({ device, discover: vi.fn().mockResolvedValue(undefined) }),
    });

    expect(await service.execute('bios_attributes', device, { payload: { pending: true } })).toEqual({
      bios_attributes: { BootMode: 'Bios' },
    });
  });

  it('set_tee returns the handler outcome as a boolean', async () => {
    const setTee = vi.fn().mockResolvedValue(true);
    const service = new RedfishService('job-1', {
      teeHandlerFactory: () => ({
        discover: vi.fn().mockResolvedValue(undefined),
        setTee,
        verifyTee: vi.fn(),
      }),
    });

    expect(await service.execute('set_tee', makeDevice())).toEqual({ success: true });
    expect(setTee).toHaveBeenCalledWith();
  });

  it('verify_tee discovers before it verifies the BIOS values', async () => {
    const order: string[] = [];
    const service = new RedfishService('job-1', {
      teeHandlerFactory: () => ({
        discover: async () => {
          order.push('discover');
        },
        setTee: vi.fn(),
        verifyTee: async () => {
          order.push('verifyTee');
          return { ok: true, checked: true, missing: [] };
        },
      }),
    });

    expect(await service.execute('verify_tee', makeDevice())).toEqual({ ok: true, checked: true, missing: [] });
    expect(order).toEqual(['discover', 'verifyTee']);
  });

  it('rejects unknown commands', async () => {
    const service = new RedfishService('job-1');
    await expect(service.execute('bogus', makeDevice())).rejects.toThrow(/Unknown Redfish command/);
  });
});
