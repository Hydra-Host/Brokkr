import type { Mock } from 'vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { JsonRecord } from '../vendor/base/base.js';
import { RedfishDevice } from '../vendor/base/base.js';
import { RedfishTeeHandler } from '../vendor/base/tee.js';

interface Harness {
  device: RedfishDevice;
  handler: RedfishTeeHandler;
  setBios: Mock;
  seq: Mock;
  reboot: Mock;
}

interface BuildOptions {
  biosParams?: JsonRecord;
  rebootNeeded?: boolean;
  displayNameToAttr?: Record<string, string> | undefined;
}

function build(vendor: string, controller: string, model: string, opts: BuildOptions = {}): Harness {
  const device = new RedfishDevice('test-job', '42', '10.0.0.1');
  device.vendor = vendor;
  device.controller = controller;
  device.model = model;
  device.biosParams = opts.biosParams ?? {};
  device.rebootNeeded = opts.rebootNeeded ?? false;
  if (opts.displayNameToAttr !== undefined) {
    device.displayNameToAttr = opts.displayNameToAttr;
  } else if (vendor === 'supermicro') {
    device.displayNameToAttr = {};
  }

  const handler = new RedfishTeeHandler(device, 'test-job');
  const setBios = vi.spyOn(handler, 'setBiosParam').mockResolvedValue(true);
  const seq = vi
    .spyOn(
      handler as unknown as { applySequentialBiosSettings: (s: Record<string, number | string>) => Promise<boolean> },
      'applySequentialBiosSettings',
    )
    .mockResolvedValue(true);
  const reboot = vi.spyOn(handler, 'reboot').mockResolvedValue();
  return {
    device,
    handler,
    setBios: setBios as unknown as Mock,
    seq: seq as unknown as Mock,
    reboot: reboot as unknown as Mock,
  };
}

function setBiosKeys(setBios: Mock): string[] {
  return setBios.mock.calls.map((call) => call[0] as string);
}

function seqBatches(seq: Mock): Record<string, number | string>[] {
  return seq.mock.calls.map((call) => call[0] as Record<string, number | string>);
}

function flatten(batches: Record<string, number | string>[]): string[] {
  return batches.flatMap((b) => Object.keys(b));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('unsupported vendor', () => {
  it('returns false on enable for unknown vendor', async () => {
    const h = build('acme', 'bmc', 'model');
    const result = await h.handler.setTee(true);
    expect(result).toBe(false);
    expect(h.setBios).not.toHaveBeenCalled();
    expect(h.seq).not.toHaveBeenCalled();
    expect(h.reboot).not.toHaveBeenCalled();
  });

  it('returns false on disable for unknown vendor', async () => {
    const h = build('hp', 'ilo5', 'dl380');
    const result = await h.handler.setTee(false);
    expect(result).toBe(false);
  });
});

describe('aivres ast2600', () => {
  it('enable clean state runs full sequence with TDX after TME/MKTME', async () => {
    const h = build('aivres', 'ast2600', 'nf5280m6');
    const result = await h.handler.setTee(true);
    expect(result).toBe(true);
    const keys = setBiosKeys(h.setBios);
    expect(keys).toContain('ProcessorVmxEnable');
    expect(keys).toContain('VTdSupport');
    expect(keys).toContain('EnableTdx');
    expect(keys).toContain('EnableSgx');
    expect(keys[keys.length - 1]).toBe('SgxFactoryReset');
    expect(keys.indexOf('EnableTme')).toBeLessThan(keys.indexOf('EnableTdx'));
    expect(keys.indexOf('EnableMktme')).toBeLessThan(keys.indexOf('EnableTdx'));
  });

  it('enable skips already-Disabled DfxAdvDebugJumper write', async () => {
    const h = build('aivres', 'ast2600', 'nf5280m6', {
      biosParams: {
        IntelSetup: { DfxAdvDebugJumper: 'Disabled' },
        SocketSecurityConfig: { EnableTme: 'Enabled', EnableMktme: 'Enabled', EnableSgx: 'Enabled' },
      },
    });
    await h.handler.setTee(true);
    const keys = setBiosKeys(h.setBios);
    expect(keys).not.toContain('DfxAdvDebugJumper');
    expect(keys).toContain('EnableTmeBypass');
    expect(keys).toContain('EnableTdx');
  });

  it('enable reboots when DfxAdvDebugJumper is not Disabled', async () => {
    const h = build('aivres', 'ast2600', 'nf5280m6', {
      biosParams: { IntelSetup: { DfxAdvDebugJumper: 'Enabled' } },
    });
    await h.handler.setTee(true);
    const keys = setBiosKeys(h.setBios);
    expect(keys).toContain('DfxAdvDebugJumper');
    expect(h.reboot.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('terminal reboot fence fires when rebootNeeded is true', async () => {
    const h = build('aivres', 'ast2600', 'nf5280m6', { rebootNeeded: true });
    await h.handler.setTee(true);
    expect(h.reboot.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('disable runs reverse sequence with DfxAdvDebugJumper=Auto', async () => {
    const h = build('aivres', 'ast2600', 'nf5280m6');
    const result = await h.handler.setTee(false);
    expect(result).toBe(true);
    const keys = setBiosKeys(h.setBios);
    expect(keys).toContain('EnableTdx');
    expect(keys).toContain('EnableTme');
    expect(keys).toContain('EnableSgx');
    expect(keys).toContain('VMX');
    expect(h.setBios.mock.calls).toContainEqual(['DfxAdvDebugJumper', 'Auto', 'IntelSetup']);
  });
});

describe('aivres openbmc', () => {
  it('enable uses display-name keys with TDX after TME', async () => {
    const h = build('aivres', 'openbmc', 'nf5280m7');
    const result = await h.handler.setTee(true);
    expect(result).toBe(true);
    const keys = setBiosKeys(h.setBios);
    expect(keys).toContain('Trust Domain Extension (TDX)');
    expect(keys).toContain('SW Guard Extensions (SGX)');
    expect(keys).toContain('Memory Encryption (TME)');
    expect(keys).toContain('SGX Factory Reset');
    expect(keys.indexOf('Memory Encryption (TME)')).toBeLessThan(keys.indexOf('Trust Domain Extension (TDX)'));
  });

  it('disable orders SGX off → TDX off → TME off', async () => {
    const h = build('aivres', 'openbmc', 'nf5280m7');
    const result = await h.handler.setTee(false);
    expect(result).toBe(true);
    const keys = setBiosKeys(h.setBios);
    expect(keys.indexOf('SW Guard Extensions (SGX)')).toBeLessThan(keys.indexOf('Trust Domain Extension (TDX)'));
    expect(keys.indexOf('Trust Domain Extension (TDX)')).toBeLessThan(keys.indexOf('Memory Encryption (TME)'));
    expect(keys).toContain('Limit CPU PA to 46 bits');
  });
});

describe('dell idrac9', () => {
  it('enable full sequence: ProcVirtualization first, MemoryEncryption before EnableTdx', async () => {
    const h = build('dell', 'idrac9', 'r760');
    const result = await h.handler.setTee(true);
    expect(result).toBe(true);
    const batches = seqBatches(h.seq);
    expect(batches[0]).toEqual({ ProcVirtualization: 'Enabled' });
    const flat = flatten(batches);
    expect(flat.indexOf('MemoryEncryption')).toBeLessThan(flat.indexOf('EnableTdx'));
    expect(flat.indexOf('EnableTdx')).toBeLessThan(flat.indexOf('EnableTdxSeamldr'));
    expect(flat).toContain('IntelSgx');
    expect(flat).toContain('GlbMemIntegrity');
  });

  it('enable aborts on first stage failure', async () => {
    const h = build('dell', 'idrac9', 'r760');
    h.seq.mockResolvedValue(false);
    const result = await h.handler.setTee(true);
    expect(result).toBe(false);
    expect(h.seq.mock.calls.length).toBe(1);
  });

  it('disable reverses with dependency ordering', async () => {
    const h = build('dell', 'idrac9', 'r760');
    const result = await h.handler.setTee(false);
    expect(result).toBe(true);
    const flat = flatten(seqBatches(h.seq));
    expect(flat.indexOf('EnableTdxSeamldr')).toBeLessThan(flat.indexOf('EnableTdx'));
    expect(flat.indexOf('EnableTdx')).toBeLessThan(flat.indexOf('MemoryEncryption'));
    expect(flat.indexOf('MemoryEncryption')).toBeLessThan(flat.indexOf('CpuPaLimit'));
    expect(flat.indexOf('CpuPaLimit')).toBeLessThan(flat.indexOf('GlbMemIntegrity'));
    expect(flat.indexOf('GlbMemIntegrity')).toBeLessThan(flat.indexOf('IntelTxt'));
  });

  it('disable aborts on first failed stage', async () => {
    const h = build('dell', 'idrac9', 'r760');
    h.seq.mockResolvedValue(false);
    const result = await h.handler.setTee(false);
    expect(result).toBe(false);
    expect(h.seq.mock.calls.length).toBe(1);
  });

  it('disable aborts mid sequence', async () => {
    const h = build('dell', 'idrac9', 'r760');
    h.seq.mockReset();
    h.seq.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const result = await h.handler.setTee(false);
    expect(result).toBe(false);
    expect(h.seq.mock.calls.length).toBe(3);
  });

  it('enable mid-stage reboot fence fires when toggled', async () => {
    const h = build('dell', 'idrac9', 'r760');
    h.seq.mockImplementation(async () => {
      h.device.rebootNeeded = true;
      return true;
    });
    h.reboot.mockImplementation(async () => {
      h.device.rebootNeeded = false;
    });
    const result = await h.handler.setTee(true);
    expect(result).toBe(true);
    expect(h.reboot.mock.calls.length).toBeGreaterThanOrEqual(5);
  });
});

describe('lenovo xcc3 sr675', () => {
  it('enable: single batch plus SGX factory reset follow-up', async () => {
    const h = build('lenovo', 'xcc3', 'sr675');
    const result = await h.handler.setTee(true);
    expect(result).toBe(true);
    const batches = seqBatches(h.seq);
    expect(batches.length).toBe(1);
    const batch = batches[0]!;
    expect(batch['Processors_TrustDomainExtensionTDX']).toBe('Enabled');
    expect(batch['Processors_SWGuardExtensions']).toBe('Enabled');
    expect(batch['Processors_TME_MTTDXkeysplit']).toBe(1);
    const sgxResetCalls = h.setBios.mock.calls.filter((call) => call[0] === 'Processors_SGXFactoryReset');
    expect(sgxResetCalls).toEqual([['Processors_SGXFactoryReset', 'Enabled']]);
  });

  it('enable aborts on batch failure (no SGX reset)', async () => {
    const h = build('lenovo', 'xcc3', 'sr675');
    h.seq.mockResolvedValue(false);
    const result = await h.handler.setTee(true);
    expect(result).toBe(false);
    expect(h.setBios).not.toHaveBeenCalled();
  });

  it('disable: single batch, no SGX reset', async () => {
    const h = build('lenovo', 'xcc3', 'sr675');
    const result = await h.handler.setTee(false);
    expect(result).toBe(true);
    const batches = seqBatches(h.seq);
    expect(batches.length).toBe(1);
    const batch = batches[0]!;
    expect(batch['Processors_TrustDomainExtensionTDX']).toBe('Disabled');
    expect(batch['Processors_TME_MTTDXkeysplit']).toBe(0);
    expect(h.setBios).not.toHaveBeenCalled();
  });
});

describe('lenovo xcc3 sr680a/sr780a', () => {
  it('enable two-stage sequence on sr680a', async () => {
    const h = build('lenovo', 'xcc3', 'sr680a');
    const result = await h.handler.setTee(true);
    expect(result).toBe(true);
    const batches = seqBatches(h.seq);
    expect(batches[0]).toEqual({ Processors_TotalMemoryEncryption: 'Enabled' });
    expect('Processors_TrustDomainExtensionTDX' in (batches[1] ?? {})).toBe(true);
    expect(h.setBios.mock.calls).toContainEqual(['Processors_SGXFactoryReset', 'Enabled']);
  });

  it('enable two-stage sequence on sr780a', async () => {
    const h = build('lenovo', 'xcc3', 'sr780a');
    const result = await h.handler.setTee(true);
    expect(result).toBe(true);
    expect(seqBatches(h.seq).length).toBe(2);
  });

  it('enable aborts on first batch failure', async () => {
    const h = build('lenovo', 'xcc3', 'sr680a');
    h.seq.mockResolvedValue(false);
    const result = await h.handler.setTee(true);
    expect(result).toBe(false);
    expect(h.seq.mock.calls.length).toBe(1);
  });

  it('enable aborts on second batch failure (no SGX reset)', async () => {
    const h = build('lenovo', 'xcc3', 'sr680a');
    h.seq.mockReset();
    h.seq.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const result = await h.handler.setTee(true);
    expect(result).toBe(false);
    expect(h.seq.mock.calls.length).toBe(2);
    expect(h.setBios).not.toHaveBeenCalled();
  });

  it('disable two-stage', async () => {
    const h = build('lenovo', 'xcc3', 'sr680a');
    const result = await h.handler.setTee(false);
    expect(result).toBe(true);
    const batches = seqBatches(h.seq);
    expect(batches.length).toBe(2);
    expect('Processors_TrustDomainExtensionTDX' in (batches[0] ?? {})).toBe(true);
    expect(batches[1]).toEqual({ Processors_TotalMemoryEncryption: 'Disabled' });
  });

  it('disable aborts on first batch', async () => {
    const h = build('lenovo', 'xcc3', 'sr680a');
    h.seq.mockResolvedValue(false);
    const result = await h.handler.setTee(false);
    expect(result).toBe(false);
    expect(h.seq.mock.calls.length).toBe(1);
  });

  it('disable aborts on second batch', async () => {
    const h = build('lenovo', 'xcc3', 'sr680a');
    h.seq.mockReset();
    h.seq.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const result = await h.handler.setTee(false);
    expect(result).toBe(false);
    expect(h.seq.mock.calls.length).toBe(2);
  });
});

describe('supermicro', () => {
  it('enable refuses without display-name registry', async () => {
    const h = build('supermicro', 'bmc', 'x13dei', { displayNameToAttr: {} });
    const result = await h.handler.setTee(true);
    expect(result).toBe(false);
    expect(h.seq).not.toHaveBeenCalled();
    expect(h.setBios).not.toHaveBeenCalled();
    expect(h.reboot).not.toHaveBeenCalled();
  });

  it('disable also requires registry', async () => {
    const h = build('supermicro', 'bmc', 'x13dei', { displayNameToAttr: {} });
    const result = await h.handler.setTee(false);
    expect(result).toBe(false);
  });

  it('enable full sequence with registry', async () => {
    const h = build('supermicro', 'bmc', 'x13dei', { displayNameToAttr: { TDX: 'TrustDomainExtension_TDX_' } });
    const result = await h.handler.setTee(true);
    expect(result).toBe(true);
    const flat = flatten(seqBatches(h.seq));
    expect(flat.indexOf('MemoryEncryption_TME_')).toBeLessThan(flat.indexOf('TrustDomainExtension_TDX_'));
    expect(flat.indexOf('TrustDomainExtension_TDX_')).toBeLessThan(flat.indexOf('SWGuardExtensions_SGX_'));
    expect(h.setBios.mock.calls).toContainEqual(['SGXFactoryReset', 'Enabled']);
  });

  it('disable reverses with registry; LimitCPUPAto46Bits is last', async () => {
    const h = build('supermicro', 'bmc', 'x13dei', { displayNameToAttr: { TDX: 'TrustDomainExtension_TDX_' } });
    const result = await h.handler.setTee(false);
    expect(result).toBe(true);
    const flat = flatten(seqBatches(h.seq));
    expect(flat.indexOf('SWGuardExtensions_SGX_')).toBeLessThan(flat.indexOf('TrustDomainExtension_TDX_'));
    const setBiosKeysList = setBiosKeys(h.setBios);
    expect(setBiosKeysList.indexOf('MemoryEncryption_TME_')).toBeLessThan(
      setBiosKeysList.indexOf('LimitCPUPAto46Bits'),
    );
    expect(h.setBios.mock.calls).toContainEqual(['LimitCPUPAto46Bits', 'Enable']);
  });
});

describe('tag matching', () => {
  it('supermicro matches any controller (with registry)', async () => {
    const h = build('supermicro', 'redfish', 'h13dsh', { displayNameToAttr: { x: 'y' } });
    const result = await h.handler.setTee(true);
    expect(result).toBe(true);
  });

  it('lenovo sr675-foo does not match anchored sr675 branch', async () => {
    const h = build('lenovo', 'xcc3', 'sr675-foo');
    const result = await h.handler.setTee(true);
    expect(result).toBe(false);
  });

  it('aivres with unknown controller falls through', async () => {
    const h = build('aivres', 'unknown-bmc', 'model');
    const result = await h.handler.setTee(true);
    expect(result).toBe(false);
  });

  it('dell idrac8 falls through', async () => {
    const h = build('dell', 'idrac8', 'r640');
    const result = await h.handler.setTee(true);
    expect(result).toBe(false);
  });
});

describe('supermicro reboot fences', () => {
  it('enable: all fences fire when rebootNeeded toggles each batch', async () => {
    const h = build('supermicro', 'bmc', 'x13dei', { displayNameToAttr: { x: 'y' } });
    h.seq.mockImplementation(async () => {
      h.device.rebootNeeded = true;
      return true;
    });
    h.setBios.mockImplementation(async () => {
      h.device.rebootNeeded = true;
      return true;
    });
    h.reboot.mockImplementation(async () => {
      h.device.rebootNeeded = false;
    });
    const result = await h.handler.setTee(true);
    expect(result).toBe(true);
    expect(h.reboot.mock.calls.length).toBe(5);
  });

  it('disable: all fences fire', async () => {
    const h = build('supermicro', 'bmc', 'x13dei', { displayNameToAttr: { x: 'y' } });
    h.seq.mockImplementation(async () => {
      h.device.rebootNeeded = true;
      return true;
    });
    h.setBios.mockImplementation(async () => {
      h.device.rebootNeeded = true;
      return true;
    });
    h.reboot.mockImplementation(async () => {
      h.device.rebootNeeded = false;
    });
    const result = await h.handler.setTee(false);
    expect(result).toBe(true);
    expect(h.reboot.mock.calls.length).toBe(4);
  });
});

describe('aivres openbmc reboot fences', () => {
  it('enable: 2 mid + 1 terminal = 3 fences fire', async () => {
    const h = build('aivres', 'openbmc', 'nf5280m7');
    h.setBios.mockImplementation(async () => {
      h.device.rebootNeeded = true;
      return true;
    });
    h.reboot.mockImplementation(async () => {
      h.device.rebootNeeded = false;
    });
    const result = await h.handler.setTee(true);
    expect(result).toBe(true);
    expect(h.reboot.mock.calls.length).toBe(3);
  });

  it('disable: 1 terminal fence fires', async () => {
    const h = build('aivres', 'openbmc', 'nf5280m7');
    h.setBios.mockImplementation(async () => {
      h.device.rebootNeeded = true;
      return true;
    });
    h.reboot.mockImplementation(async () => {
      h.device.rebootNeeded = false;
    });
    const result = await h.handler.setTee(false);
    expect(result).toBe(true);
    expect(h.reboot.mock.calls.length).toBe(1);
  });
});

describe('lenovo sr675 reboot fence', () => {
  it('enable: SGX reset fence fires once', async () => {
    const h = build('lenovo', 'xcc3', 'sr675');
    h.seq.mockImplementation(async () => {
      h.device.rebootNeeded = true;
      return true;
    });
    h.setBios.mockImplementation(async () => {
      h.device.rebootNeeded = true;
      return true;
    });
    h.reboot.mockImplementation(async () => {
      h.device.rebootNeeded = false;
    });
    const result = await h.handler.setTee(true);
    expect(result).toBe(true);
    expect(h.reboot.mock.calls.length).toBe(1);
  });
});

describe('lenovo sr680a reboot fences', () => {
  it('enable: 3 fences fire when toggled', async () => {
    const h = build('lenovo', 'xcc3', 'sr680a');
    h.seq.mockImplementation(async () => {
      h.device.rebootNeeded = true;
      return true;
    });
    h.setBios.mockImplementation(async () => {
      h.device.rebootNeeded = true;
      return true;
    });
    h.reboot.mockImplementation(async () => {
      h.device.rebootNeeded = false;
    });
    const result = await h.handler.setTee(true);
    expect(result).toBe(true);
    expect(h.reboot.mock.calls.length).toBe(3);
  });

  it('disable: 2 fences fire', async () => {
    const h = build('lenovo', 'xcc3', 'sr680a');
    h.seq.mockImplementation(async () => {
      h.device.rebootNeeded = true;
      return true;
    });
    h.reboot.mockImplementation(async () => {
      h.device.rebootNeeded = false;
    });
    const result = await h.handler.setTee(false);
    expect(result).toBe(true);
    expect(h.reboot.mock.calls.length).toBe(2);
  });
});

describe('dell late-stage aborts', () => {
  it.each([
    [2, [true, false]],
    [3, [true, true, false]],
    [4, [true, true, true, false]],
    [5, [true, true, true, true, false]],
  ])('enable aborts at stage %i', async (expected, outcomes) => {
    const h = build('dell', 'idrac9', 'r760');
    h.seq.mockReset();
    for (const v of outcomes) h.seq.mockResolvedValueOnce(v);
    const result = await h.handler.setTee(true);
    expect(result).toBe(false);
    expect(h.seq.mock.calls.length).toBe(expected);
  });

  it.each([2, 3, 4, 5, 6])('disable aborts at stage %i', async (failAt) => {
    const h = build('dell', 'idrac9', 'r760');
    h.seq.mockReset();
    for (let i = 0; i < failAt - 1; i++) h.seq.mockResolvedValueOnce(true);
    h.seq.mockResolvedValueOnce(false);
    const result = await h.handler.setTee(false);
    expect(result).toBe(false);
    expect(h.seq.mock.calls.length).toBe(failAt);
  });
});

describe('TEE verification', () => {
  it('verifies Aivres AST2600 source BIOS keys', async () => {
    const h = build('aivres', 'ast2600', 'nf5280m6', {
      biosParams: {
        SocketSecurityConfig: {
          EnableTme: 'Enabled',
          EnableMktme: 'Enabled',
          EnableTdx: 'Enabled',
          EnableSgx: 'Enabled',
        },
      },
    });

    expect(await h.handler.verifyTee()).toEqual({ ok: true, checked: true, missing: [] });
  });

  it('reports an Aivres OpenBMC mismatch with the key, expected values, and actual value', async () => {
    const h = build('aivres', 'openbmc', 'nf5280m7', {
      biosParams: {
        SocketSecurityConfig: {
          'Memory Encryption (TME)': 'Enabled',
          'Total Memory Encryption Multi-Tenant(TME-MT)': 'Enabled',
          'Trust Domain Extension (TDX)': 'Disabled',
          'SW Guard Extensions (SGX)': 'Enabled',
        },
      },
    });

    expect(await h.handler.verifyTee()).toEqual({
      ok: false,
      checked: true,
      missing: [{ key: 'Trust Domain Extension (TDX)', expected: ['Enabled'], actual: 'Disabled' }],
    });
  });

  it('verifies Dell source BIOS keys and accepts the On SGX value', async () => {
    const h = build('dell', 'idrac9', 'r760', {
      biosParams: {
        EnableTdx: 'Enabled',
        MemoryEncryption: 'MultipleKeys',
        EnableTdxSeamldr: 'Enabled',
        IntelSgx: 'On',
      },
    });

    expect(await h.handler.verifyTee()).toEqual({ ok: true, checked: true, missing: [] });
  });

  it('verifies supported Lenovo source BIOS keys', async () => {
    const h = build('lenovo', 'xcc3', 'sr780a', {
      biosParams: {
        Processors_TrustDomainExtensionTDX: 'Enabled',
        Processors_MultikeyTotalMemoryEncryption: 'Enabled',
        Processors_TDXSecureArbitrationModeLoaderSEAMLoader: 'Enabled',
      },
    });

    expect(await h.handler.verifyTee()).toEqual({ ok: true, checked: true, missing: [] });
  });

  it('does not check an unsupported Lenovo model', async () => {
    const h = build('lenovo', 'xcc3', 'sr675-foo');

    expect(await h.handler.verifyTee()).toEqual({ ok: true, checked: false, missing: [] });
  });

  it('verifies Supermicro source BIOS keys without the display-name registry', async () => {
    const h = build('supermicro', 'bmc', 'x13dei', {
      biosParams: {
        MemoryEncryption_TME_: 'Enabled',
        TotalMemoryEncryptionMulti_Tenant_TME_MT_: 'Enabled',
        TrustDomainExtension_TDX_: 'Enabled',
        TDXSecureArbitrationModeLoader_SEAMLoader_: 'Enabled',
        SWGuardExtensions_SGX_: 'Enabled',
      },
    });
    h.device.displayNameToAttr = undefined;

    expect(await h.handler.verifyTee()).toEqual({ ok: true, checked: true, missing: [] });
  });

  it('reports null as the actual value for a missing BIOS key', async () => {
    const h = build('dell', 'idrac9', 'r760', {
      biosParams: {
        EnableTdx: 'Enabled',
        MemoryEncryption: 'MultipleKeys',
        IntelSgx: 'Enabled',
      },
    });

    expect(await h.handler.verifyTee()).toEqual({
      ok: false,
      checked: true,
      missing: [{ key: 'EnableTdxSeamldr', expected: ['Enabled'], actual: null }],
    });
  });
});
