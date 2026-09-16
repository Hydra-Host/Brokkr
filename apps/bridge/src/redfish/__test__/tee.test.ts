import type { Mock } from 'vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { JsonRecord } from '../vendor/base/base.js';
import { RedfishDevice } from '../vendor/base/base.js';
import { RedfishTeeHandler } from '../vendor/base/tee.js';
import type { SupermicroTeeResolution } from '../vendor/supermicro/tee-attributes.js';
import {
  resolveSupermicroTee,
  SUPERMICRO_TEE_ATTRIBUTES,
  SUPERMICRO_TEE_STAGES,
} from '../vendor/supermicro/tee-attributes.js';
import {
  discoverSupermicroTeeHandler,
  FakeSupermicroBmc,
  loadSupermicroTeeFixture,
  registryAttributes,
  SUPERMICRO_SD_PATH,
  SUPERMICRO_X13_ASSUMED_FIXTURE,
  SUPERMICRO_X14_FIXTURE,
  withRegistryAttributes,
} from './supermicro-tee.testutil.js';

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
}

function build(vendor: string, controller: string, model: string, opts: BuildOptions = {}): Harness {
  const device = new RedfishDevice('test-job', '42', '10.0.0.1');
  device.vendor = vendor;
  device.controller = controller;
  device.model = model;
  device.redfishEndpoint = '/redfish/v1';
  device.biosParams = opts.biosParams ?? {};
  device.rebootNeeded = opts.rebootNeeded ?? false;

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
  it('enable refuses without a bios registry', async () => {
    const h = build('supermicro', 'ast2600', 'sys-222ha-tn');
    const result = await h.handler.setTee(true);
    expect(result).toBe(false);
    expect(h.seq).not.toHaveBeenCalled();
    expect(h.setBios).not.toHaveBeenCalled();
    expect(h.reboot).not.toHaveBeenCalled();
  });

  it('disable also requires the registry', async () => {
    const h = build('supermicro', 'ast2600', 'sys-222ha-tn');
    const result = await h.handler.setTee(false);
    expect(result).toBe(false);
  });
});

describe('supermicro tee catalog', () => {
  it('stages every setting on enable and exactly the settings with an off value on disable', () => {
    const ids = Object.keys(SUPERMICRO_TEE_ATTRIBUTES).sort();
    const withOff = Object.entries(SUPERMICRO_TEE_ATTRIBUTES)
      .filter(([, attribute]) => attribute.off !== undefined)
      .map(([id]) => id)
      .sort();
    const enable = SUPERMICRO_TEE_STAGES.enable.flat();
    const disable = SUPERMICRO_TEE_STAGES.disable.flat();

    expect([...enable].sort()).toEqual(ids);
    expect(new Set(enable).size).toBe(enable.length);
    expect([...disable].sort()).toEqual(withOff);
    expect(new Set(disable).size).toBe(disable.length);
    expect(ids.filter((id) => !withOff.includes(id))).toEqual(['keySplit']);
  });
});

const X14_ENABLE_ORDER = [
  'MemoryEncryption_TME_',
  'TotalMemoryEncryptionMulti_Tenant_TME_MT_',
  'TrustDomainExtensions_TDX_',
  'TDXSecureArbitrationModeLoader_SEAMLoader_',
  'SWGuardExtensions_SGX_',
  'SGXPackageInfoIn_BandAccess',
  'SGXFactoryReset',
];

const X14_ENABLED: JsonRecord = Object.fromEntries(X14_ENABLE_ORDER.map((key) => [key, 'Enabled']));
const X14_CONFIGURED: JsonRecord = { ...X14_ENABLED, SGXFactoryReset: 'Disabled' };

const X14_HIDDEN_PA_LIMIT = 'LimitCPUPAto46bits_F319';
const X14_HIDDEN_TDX_SPLIT = 'TME_MT_TDXKeySplit_F31D';

function resolvedNames(resolution: SupermicroTeeResolution): Record<string, string> {
  return Object.fromEntries(Object.entries(resolution.resolved).map(([id, setting]) => [id, setting.key]));
}

function resolvedDesired(resolution: SupermicroTeeResolution): Record<string, readonly unknown[]> {
  return Object.fromEntries(Object.entries(resolution.resolved).map(([id, setting]) => [id, setting.desired]));
}

function x14Bmc(overrides: { live?: JsonRecord; registry?: (entries: JsonRecord[]) => JsonRecord[] } = {}) {
  const fixture = loadSupermicroTeeFixture(SUPERMICRO_X14_FIXTURE);
  const registry = overrides.registry
    ? withRegistryAttributes(fixture, overrides.registry(registryAttributes(fixture)))
    : fixture;
  return new FakeSupermicroBmc({ fixture: registry, live: { ...fixture.attributes, ...(overrides.live ?? {}) } });
}

describe('supermicro x14 fixture', () => {
  it('resolves every descriptor against the live registry', async () => {
    const { device } = await discoverSupermicroTeeHandler(new FakeSupermicroBmc());

    const resolution = resolveSupermicroTee(device, 'enable');

    expect(resolvedNames(resolution)).toEqual({
      limitPa: X14_HIDDEN_PA_LIMIT,
      tme: 'MemoryEncryption_TME_',
      tmeMt: 'TotalMemoryEncryptionMulti_Tenant_TME_MT_',
      tdx: 'TrustDomainExtensions_TDX_',
      seamLoader: 'TDXSecureArbitrationModeLoader_SEAMLoader_',
      keySplit: X14_HIDDEN_TDX_SPLIT,
      sgx: 'SWGuardExtensions_SGX_',
      sgxPackageInfo: 'SGXPackageInfoIn_BandAccess',
      sgxFactoryReset: 'SGXFactoryReset',
    });
    expect(resolvedDesired(resolution)).toEqual({
      limitPa: ['Disabled', '0'],
      tme: ['Enabled', '1'],
      tmeMt: ['Enabled', '1'],
      tdx: ['Enabled', '1'],
      seamLoader: ['Enabled', '1'],
      keySplit: [1, '1'],
      sgx: ['Enabled', '1'],
      sgxPackageInfo: ['Enabled', '1'],
      sgxFactoryReset: ['Enabled', '1'],
    });
    expect(resolution.failures).toEqual([]);
    expect(resolution.skipped).toEqual([
      {
        id: 'tmeBypass',
        reason: 'absent',
        key: null,
        detail: expect.stringContaining('TotalMemoryEncryption_TME_Bypass'),
      },
    ]);
    expect(resolution.stages).toEqual([
      { MemoryEncryption_TME_: 'Enabled' },
      { TotalMemoryEncryptionMulti_Tenant_TME_MT_: 'Enabled' },
      { TrustDomainExtensions_TDX_: 'Enabled', TDXSecureArbitrationModeLoader_SEAMLoader_: 'Enabled' },
      { SWGuardExtensions_SGX_: 'Enabled', SGXPackageInfoIn_BandAccess: 'Enabled' },
      { SGXFactoryReset: 'Enabled' },
    ]);
  });

  it('enable patches only unsatisfied visible keys in stage order and never a hidden key or bypass', async () => {
    const bmc = new FakeSupermicroBmc();
    const handler = await discoverSupermicroTeeHandler(bmc);

    expect(await handler.setTee(true)).toBe(true);

    expect(bmc.patches).toEqual(X14_ENABLE_ORDER.map((key) => ({ [key]: 'Enabled' })));
    expect(bmc.patchedKeys()).not.toContain(X14_HIDDEN_PA_LIMIT);
    expect(bmc.patchedKeys()).not.toContain(X14_HIDDEN_TDX_SPLIT);
    expect(bmc.patchedKeys().some((key) => key.includes('Bypass'))).toBe(false);
    expect(bmc.live['TrustDomainExtensions_TDX_']).toBe('Enabled');
  });

  it('fences with a settled reboot after every stage that patched although ResetRequired is null', async () => {
    const bmc = new FakeSupermicroBmc();
    const handler = await discoverSupermicroTeeHandler(bmc);

    await handler.setTee(true);

    expect(bmc.resets).toBe(5);
    const writes = bmc.requests.filter((request) => request.method !== 'GET').map((request) => request.method);
    expect(writes).toEqual([
      'PATCH',
      'POST',
      'PATCH',
      'POST',
      'PATCH',
      'PATCH',
      'POST',
      'PATCH',
      'PATCH',
      'POST',
      'PATCH',
      'POST',
    ]);
    expect(handler.device.rebootNeeded).toBe(false);
    expect(handler.device.biosPendingParams).toEqual({});
  });

  it('reads the pending map back after every bare 2xx patch reply', async () => {
    const bmc = new FakeSupermicroBmc();
    const handler = await discoverSupermicroTeeHandler(bmc);

    expect(await handler.setTee(true)).toBe(true);

    const afterPatch = bmc.requests.filter((_, index) => bmc.requests[index - 1]?.method === 'PATCH');
    expect(afterPatch.map((request) => [request.method, request.path])).toEqual(
      Array.from({ length: 7 }, () => ['GET', SUPERMICRO_SD_PATH]),
    );
  });

  it('enables end to end when the patch reply carries extended info', async () => {
    const bmc = new FakeSupermicroBmc({ patchReply: 'extended-info' });
    const handler = await discoverSupermicroTeeHandler(bmc);

    expect(await handler.setTee(true)).toBe(true);

    expect(bmc.patches).toEqual(X14_ENABLE_ORDER.map((key) => ({ [key]: 'Enabled' })));
    expect(bmc.resets).toBe(5);
    const afterPatch = bmc.requests.filter((_, index) => bmc.requests[index - 1]?.method === 'PATCH');
    expect(afterPatch.some((request) => request.method === 'GET')).toBe(false);
  });

  it('fails the stage before any later one when a bare 2xx patch never reaches the pending map', async () => {
    const bmc = new FakeSupermicroBmc({
      sdEchoesLive: false,
      dropPendingKeys: ['TotalMemoryEncryptionMulti_Tenant_TME_MT_'],
    });
    const handler = await discoverSupermicroTeeHandler(bmc);

    expect(await handler.setTee(true)).toBe(false);

    expect(bmc.patchedKeys()).toEqual(['MemoryEncryption_TME_', 'TotalMemoryEncryptionMulti_Tenant_TME_MT_']);
    expect(bmc.resets).toBe(1);
    expect(bmc.live['TrustDomainExtensions_TDX_']).toBe('Disabled');
  });

  it('sends the display form when the desired value matches a ValueName', async () => {
    const bmc = x14Bmc({
      live: { MemoryEncryption_TME_: 'Off' },
      registry: (entries) =>
        entries.map((entry) =>
          entry['AttributeName'] === 'MemoryEncryption_TME_'
            ? {
                ...entry,
                CurrentValue: 'Off',
                Value: [
                  { ValueDisplayName: 'Off', ValueName: 'Disabled' },
                  { ValueDisplayName: 'On', ValueName: 'Enabled' },
                ],
              }
            : entry,
        ),
    });
    const handler = await discoverSupermicroTeeHandler(bmc);

    expect(await handler.setTee(true)).toBe(true);

    expect(bmc.patches[0]).toEqual({ MemoryEncryption_TME_: 'On' });
    expect(bmc.live['MemoryEncryption_TME_']).toBe('On');
    expect(resolvedDesired(resolveSupermicroTee(handler.device, 'enable'))['tme']).toEqual(['Enabled', 'On']);
    expect(await handler.verifyTee()).toEqual({ ok: true, checked: true, missing: [] });
  });

  it('returns false before any patch when the desired value is not in the vocabulary', async () => {
    const bmc = x14Bmc({
      registry: (entries) =>
        entries.map((entry) =>
          entry['AttributeName'] === 'MemoryEncryption_TME_'
            ? {
                ...entry,
                Value: [
                  { ValueDisplayName: 'Off', ValueName: '0' },
                  { ValueDisplayName: 'On', ValueName: '1' },
                ],
              }
            : entry,
        ),
    });
    const handler = await discoverSupermicroTeeHandler(bmc);

    expect(await handler.setTee(true)).toBe(false);

    expect(bmc.patches).toEqual([]);
    expect(resolveSupermicroTee(handler.device, 'enable').failures).toEqual([
      { id: 'tme', reason: 'value-not-in-vocabulary', detail: 'MemoryEncryption_TME_ has no value Enabled' },
    ]);
  });

  it('returns false before any patch when tdx is missing from the registry', async () => {
    const bmc = x14Bmc({
      registry: (entries) => entries.filter((entry) => entry['AttributeName'] !== 'TrustDomainExtensions_TDX_'),
    });
    const handler = await discoverSupermicroTeeHandler(bmc);

    expect(await handler.setTee(true)).toBe(false);

    expect(bmc.patches).toEqual([]);
    expect(bmc.resets).toBe(0);
    expect(resolveSupermicroTee(handler.device, 'enable').failures).toEqual([
      { id: 'tdx', reason: 'absent', detail: expect.stringContaining('TrustDomainExtensions_TDX_') },
    ]);
  });

  it('fails as ambiguous when two suffixed keys normalize to the same name', async () => {
    const bmc = x14Bmc({
      registry: (entries) =>
        entries.flatMap((entry) =>
          entry['AttributeName'] === 'TrustDomainExtensions_TDX_'
            ? [
                { ...entry, AttributeName: 'TrustDomainExtensions_TDX__F001' },
                { ...entry, AttributeName: 'TrustDomainExtensions_TDX__F002' },
              ]
            : [entry],
        ),
    });
    const { device } = await discoverSupermicroTeeHandler(bmc);

    expect(resolveSupermicroTee(device, 'enable').failures).toEqual([
      { id: 'tdx', reason: 'ambiguous', detail: expect.stringContaining('_F002') },
    ]);
  });

  it('returns false and runs no later stage when a stage patch fails', async () => {
    const bmc = new FakeSupermicroBmc({ failPatchKeys: ['TotalMemoryEncryptionMulti_Tenant_TME_MT_'] });
    const handler = await discoverSupermicroTeeHandler(bmc);

    expect(await handler.setTee(true)).toBe(false);

    expect(bmc.patchedKeys()).toEqual(['MemoryEncryption_TME_', 'TotalMemoryEncryptionMulti_Tenant_TME_MT_']);
    expect(bmc.resets).toBe(1);
  });

  it('is a no-op on a configured board and does not re-fire the sgx factory reset', async () => {
    const bmc = x14Bmc({ live: X14_CONFIGURED });
    const handler = await discoverSupermicroTeeHandler(bmc);

    const resolution = resolveSupermicroTee(handler.device, 'enable');
    expect(resolution.stages).toEqual([]);
    expect(resolution.skipped).toContainEqual(
      expect.objectContaining({
        id: 'sgxFactoryReset',
        reason: 'fire-once',
        detail: expect.stringContaining('SGXFactoryReset not re-fired'),
      }),
    );

    expect(await handler.setTee(true)).toBe(true);

    expect(bmc.patches).toEqual([]);
    expect(bmc.resets).toBe(0);
  });

  it('fires the sgx factory reset only in the run that turns sgx on', async () => {
    const bmc = x14Bmc({
      live: { ...X14_CONFIGURED, SWGuardExtensions_SGX_: 'Disabled', SGXPackageInfoIn_BandAccess: 'Disabled' },
    });
    const handler = await discoverSupermicroTeeHandler(bmc);

    expect(await handler.setTee(true)).toBe(true);

    expect(bmc.patchedKeys()).toEqual(['SWGuardExtensions_SGX_', 'SGXPackageInfoIn_BandAccess', 'SGXFactoryReset']);
    expect(bmc.resets).toBe(2);
  });

  it('disable writes Disabled in reverse order and leaves the hidden pa limit alone', async () => {
    const bmc = x14Bmc({ live: X14_ENABLED });
    const handler = await discoverSupermicroTeeHandler(bmc);

    expect(await handler.setTee(false)).toBe(true);

    expect(bmc.patches).toEqual([
      { SGXPackageInfoIn_BandAccess: 'Disabled' },
      { SWGuardExtensions_SGX_: 'Disabled' },
      { SGXFactoryReset: 'Disabled' },
      { TDXSecureArbitrationModeLoader_SEAMLoader_: 'Disabled' },
      { TrustDomainExtensions_TDX_: 'Disabled' },
      { TotalMemoryEncryptionMulti_Tenant_TME_MT_: 'Disabled' },
      { MemoryEncryption_TME_: 'Disabled' },
    ]);
    expect(bmc.resets).toBe(3);
    expect(resolveSupermicroTee(handler.device, 'disable').skipped).toContainEqual({
      id: 'limitPa',
      reason: 'hidden',
      key: X14_HIDDEN_PA_LIMIT,
      detail: expect.stringContaining(X14_HIDDEN_PA_LIMIT),
    });
  });

  it('verifyTee reads the plural tdx key', async () => {
    const bmc = new FakeSupermicroBmc();
    const handler = await discoverSupermicroTeeHandler(bmc);

    const before = await handler.verifyTee();
    expect(before.ok).toBe(false);
    expect(before.checked).toBe(true);
    expect(before.missing).toContainEqual({
      key: 'TrustDomainExtensions_TDX_',
      expected: ['Enabled', '1'],
      actual: 'Disabled',
    });

    await handler.setTee(true);

    expect(await handler.verifyTee()).toEqual({ ok: true, checked: true, missing: [] });
  });

  it('resolves the assumed x13 names and writes the visible pa limit and bypass', async () => {
    const bmc = new FakeSupermicroBmc({
      fixture: loadSupermicroTeeFixture(SUPERMICRO_X13_ASSUMED_FIXTURE),
      sdEchoesLive: false,
    });
    const handler = await discoverSupermicroTeeHandler(bmc);

    const resolution = resolveSupermicroTee(handler.device, 'enable');
    const { failures, skipped } = resolution;
    expect(resolvedNames(resolution)).toMatchObject({
      tdx: 'TrustDomainExtension_TDX_',
      limitPa: 'LimitCPUPAto46Bits',
      tmeBypass: 'TotalMemoryEncryption_TME_Bypass',
      keySplit: 'TME_MT_TDXKeySplit',
    });
    expect(failures).toEqual([]);
    expect(skipped).toEqual([]);

    expect(await handler.setTee(true)).toBe(true);

    expect(bmc.patches[0]).toEqual({ LimitCPUPAto46Bits: 'Disabled' });
    expect(bmc.patchedKeys()).toEqual([
      'LimitCPUPAto46Bits',
      'MemoryEncryption_TME_',
      'TotalMemoryEncryptionMulti_Tenant_TME_MT_',
      'TotalMemoryEncryption_TME_Bypass',
      'TrustDomainExtension_TDX_',
      'TDXSecureArbitrationModeLoader_SEAMLoader_',
      'SWGuardExtensions_SGX_',
      'SGXPackageInfoIn_BandAccess',
      'SGXFactoryReset',
    ]);
    expect(bmc.resets).toBe(5);
  });
});

describe('tag matching', () => {
  it('supermicro matches any controller once the registry is discovered', async () => {
    const bmc = new FakeSupermicroBmc();
    const handler = await discoverSupermicroTeeHandler(bmc);
    handler.device.controller = 'redfish';
    handler.device.model = 'h13dsh';

    expect(await handler.setTee(true)).toBe(true);
    expect(bmc.patches.length).toBeGreaterThan(0);
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
    const h = build('lenovo', 'xcc3', 'sr675-foo', { biosParams: { BootMode: 'UEFI' } });

    expect(await h.handler.verifyTee()).toEqual({ ok: true, checked: false, missing: [], reason: 'unmodeled' });
  });

  it('verifies supermicro live keys when no registry was discovered', async () => {
    const h = build('supermicro', 'bmc', 'x13dei', {
      biosParams: {
        MemoryEncryption_TME_: 'Enabled',
        TotalMemoryEncryptionMulti_Tenant_TME_MT_: 'Enabled',
        TrustDomainExtension_TDX_: 'Enabled',
        TDXSecureArbitrationModeLoader_SEAMLoader_: 'Enabled',
        SWGuardExtensions_SGX_: 'Enabled',
      },
    });

    expect(await h.handler.verifyTee()).toEqual({ ok: true, checked: true, missing: [] });
  });

  it('verifies the plural tdx key from the live map when no registry was discovered', async () => {
    const h = build('supermicro', 'ast2600', 'sys-222ha-tn', {
      biosParams: {
        MemoryEncryption_TME_: 'Enabled',
        TotalMemoryEncryptionMulti_Tenant_TME_MT_: 'Enabled',
        TrustDomainExtensions_TDX_: 'Enabled',
        TDXSecureArbitrationModeLoader_SEAMLoader_: 'Enabled',
        SWGuardExtensions_SGX_: 'Enabled',
      },
    });

    expect(await h.handler.verifyTee()).toEqual({ ok: true, checked: true, missing: [] });
  });

  it('verifies a suffixed live key with the registry rules when no registry was discovered', async () => {
    const h = build('supermicro', 'ast2600', 'sys-222ha-tn', {
      biosParams: {
        MemoryEncryption_TME_: 'Enabled',
        TotalMemoryEncryptionMulti_Tenant_TME_MT_: 'Enabled',
        TrustDomainExtensions_TDX_: 'Enabled',
        TDXSecureArbitrationModeLoader_SEAMLoader_: 'Enabled',
        SWGuardExtensions_SGX__F30C: 'Enabled',
      },
    });

    expect(await h.handler.verifyTee()).toEqual({ ok: true, checked: true, missing: [] });
  });

  it('reports the first candidate name missing when neither the registry nor the live map carries it', async () => {
    const h = build('supermicro', 'ast2600', 'sys-222ha-tn', {
      biosParams: {
        MemoryEncryption_TME_: 'Enabled',
        TotalMemoryEncryptionMulti_Tenant_TME_MT_: 'Enabled',
        TDXSecureArbitrationModeLoader_SEAMLoader_: 'Enabled',
        SWGuardExtensions_SGX_: 'Enabled',
      },
    });

    expect(await h.handler.verifyTee()).toEqual({
      ok: false,
      checked: true,
      missing: [{ key: 'TrustDomainExtensions_TDX_', expected: ['Enabled'], actual: null }],
    });
  });

  it('reports bmc-unreachable for supermicro when discovery yielded no bios attributes', async () => {
    const h = build('supermicro', 'ast2600', 'sys-222ha-tn');

    expect(await h.handler.verifyTee()).toEqual({ ok: false, checked: false, missing: [], reason: 'bmc-unreachable' });
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
