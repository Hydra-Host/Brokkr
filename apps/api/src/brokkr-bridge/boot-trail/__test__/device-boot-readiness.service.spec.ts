import type { DeviceBootTrail } from '@repo/api-client';
import { BaremetalRecord } from 'src/devices/baremetal.record';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeviceBootReadinessService } from '../device-boot-readiness.service';

const DEVICE = '22222222-2222-2222-2222-222222222222';
const ZONE = '11111111-1111-1111-1111-111111111111';
const PREFIX = '33333333-3333-3333-3333-333333333333';
const MAC = '3c:ec:ef:1a:2b:3c';

const trail = (over: Partial<DeviceBootTrail> = {}): DeviceBootTrail => ({
  deviceId: DEVICE,
  pxeMac: MAC,
  pxeInterface: 'eth0',
  pxeMacSource: 'address',
  candidateMacs: [],
  zoneId: ZONE,
  trail: {
    pxe: { outcome: 'offered', atMs: 1789560131000 },
    chainReached: true,
    chainAtMs: null,
    chainDeviceMismatch: false,
    readError: null,
  },
  bootExpected: { expected: false, since: null, reason: 'none' },
  readAt: '2026-09-16T12:00:00.000Z',
  ...over,
});

function setup(opts: {
  trail?: DeviceBootTrail;
  prefix?: { id: string; selection: 'containing' | 'primary' } | null;
  hubFindings?: Array<{ code: 'PXE-102' | 'PXE-104'; severity: 'error'; message: string }>;
}) {
  vi.spyOn(BaremetalRecord, 'findByDeviceIdOrThrow').mockResolvedValue({
    data: { id: DEVICE, name: 'gpu-node-07', interfaces: [] },
  } as unknown as BaremetalRecord);
  const bootTrail = { readForRecord: vi.fn().mockResolvedValue(opts.trail ?? trail()) };
  const prefixRepository = {
    findBootPrefixForDevice: vi
      .fn()
      .mockResolvedValue(opts.prefix === undefined ? { id: PREFIX, selection: 'containing' } : opts.prefix),
  };
  const prefixReadiness = { check: vi.fn().mockResolvedValue({ findings: opts.hubFindings ?? [] }) };
  const service = new DeviceBootReadinessService(bootTrail, prefixRepository, prefixReadiness);
  return { service, prefixReadiness, prefixRepository };
}

describe('DeviceBootReadinessService.evaluate', () => {
  afterEach(() => vi.restoreAllMocks());

  it('merges hub prefix findings with the prefix id and tags the source', async () => {
    const { service, prefixReadiness } = setup({
      hubFindings: [{ code: 'PXE-104', severity: 'error', message: 'excluded' }],
    });
    const out = await service.evaluate(DEVICE);
    expect(prefixReadiness.check).toHaveBeenCalledWith(PREFIX, { mac: MAC, bmcAddress: undefined });
    expect(out.findings).toEqual([
      { code: 'PXE-104', severity: 'error', message: 'excluded', source: 'hub-prefix', prefixId: PREFIX },
    ]);
    expect(out.prefixSelection).toBe('containing');
    expect(out.evaluated).toEqual({ hubPrefix: true, bootTrail: true, bootedWithoutDhcp: false });
  });

  it('reports PXE-107 and hubPrefix false when no prefix is selected', async () => {
    const { service, prefixReadiness } = setup({ prefix: null });
    const out = await service.evaluate(DEVICE);
    expect(prefixReadiness.check).not.toHaveBeenCalled();
    expect(out.findings.map((f) => f.code)).toEqual(['PXE-107']);
    expect(out.evaluated.hubPrefix).toBe(false);
    expect(out.prefixSelection).toBe('none');
  });

  it('adds the trail finding when a boot is expected and the trail is silent', async () => {
    const { service } = setup({
      trail: trail({
        trail: { pxe: null, chainReached: false, chainAtMs: null, chainDeviceMismatch: false, readError: null },
        bootExpected: { expected: true, since: '2026-09-16T11:00:00.000Z', reason: 'active-job' },
      }),
    });
    const out = await service.evaluate(DEVICE);
    expect(out.findings.map((f) => [f.code, f.source])).toEqual([['PXE-111', 'boot-trail']]);
  });

  it('reports one PXE-107 from the trail when the device has no data MAC', async () => {
    const { service, prefixReadiness } = setup({
      trail: trail({
        pxeMac: null,
        zoneId: null,
        trail: {
          pxe: null,
          chainReached: null,
          chainAtMs: null,
          chainDeviceMismatch: false,
          readError: 'no data interface with a MAC',
        },
      }),
    });
    const out = await service.evaluate(DEVICE);
    expect(prefixReadiness.check).not.toHaveBeenCalled();
    expect(out.findings.map((f) => [f.code, f.source])).toEqual([['PXE-107', 'boot-trail']]);
    expect(out.evaluated).toEqual({ hubPrefix: false, bootTrail: false, bootedWithoutDhcp: false });
  });

  it('reports one PXE-107 from the trail when the zone could not be resolved', async () => {
    const { service, prefixRepository, prefixReadiness } = setup({
      trail: trail({
        zoneId: null,
        trail: {
          pxe: null,
          chainReached: null,
          chainAtMs: null,
          chainDeviceMismatch: false,
          readError: 'Device has no zone assigned',
        },
      }),
    });
    const out = await service.evaluate(DEVICE);
    expect(prefixRepository.findBootPrefixForDevice).not.toHaveBeenCalled();
    expect(prefixReadiness.check).not.toHaveBeenCalled();
    expect(out.findings.map((f) => [f.code, f.source])).toEqual([['PXE-107', 'boot-trail']]);
    expect(out.evaluated).toEqual({ hubPrefix: false, bootTrail: false, bootedWithoutDhcp: false });
  });

  it('flags a boot that reached the chain without a bridge decision and raises no trail finding', async () => {
    const { service } = setup({
      trail: trail({
        trail: {
          pxe: null,
          chainReached: true,
          chainAtMs: Date.parse('2026-09-16T11:05:00.000Z'),
          chainDeviceMismatch: false,
          readError: null,
        },
        bootExpected: { expected: true, since: '2026-09-16T11:00:00.000Z', reason: 'active-job' },
      }),
    });
    const out = await service.evaluate(DEVICE);
    expect(out.evaluated.bootedWithoutDhcp).toBe(true);
    expect(out.findings).toEqual([]);
  });

  it('marks the trail unevaluated when redis was unreadable', async () => {
    const { service } = setup({
      trail: trail({
        trail: {
          pxe: null,
          chainReached: null,
          chainAtMs: null,
          chainDeviceMismatch: false,
          readError: 'ECONNREFUSED',
        },
      }),
    });
    const out = await service.evaluate(DEVICE);
    expect(out.evaluated.bootTrail).toBe(false);
    expect(out.findings.map((f) => f.code)).toEqual(['PXE-107']);
  });
});
