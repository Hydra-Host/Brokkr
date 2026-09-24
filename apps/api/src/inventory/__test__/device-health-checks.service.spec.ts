import { NotFoundException } from '@nestjs/common';
import { BaremetalRecord } from 'src/devices/baremetal.record';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeviceHealthChecksService } from '../device-health-checks.service';

const DEVICE = '22222222-2222-2222-2222-222222222222';
const ZONE = '11111111-1111-1111-1111-111111111111';
const SUPPLIER = 'org-supplier';
const CUSTOMER = 'org-customer';

const row = {
  id: 'hc-1',
  deviceId: DEVICE,
  primaryReachable: true,
  bmcIcmpReachable: true,
  bmcIpmiReachable: true,
  bmcRedfishReachable: true,
  bmcCredsValid: false,
  poweredOn: true,
  brokkrLiveRunning: null,
  testedAt: new Date('2026-09-16T11:21:00.000Z'),
};

const snapshot = {
  device_id: DEVICE,
  primary_reachable: true,
  bmc_icmp_reachable: true,
  bmc_ipmi_reachable: true,
  bmc_redfish_reachable: true,
  bmc_creds_valid: true,
  powered_on: true,
  brokkr_live_running: null,
  checked_at: Date.parse('2026-09-16T11:56:00.000Z') / 1000,
};

function setup(opts: {
  org: string;
  device?: { supplierId: string } | null;
  snapshot?: object | null;
  latest?: typeof row | null;
}) {
  const prisma = {
    device: {
      findUnique: vi
        .fn()
        .mockResolvedValue(
          opts.device === undefined
            ? { id: DEVICE, supplierId: SUPPLIER, server: { ecoMode: false } }
            : opts.device && { id: DEVICE, ...opts.device, server: { ecoMode: false } },
        ),
    },
    deviceHealthCheck: {
      findFirst: vi.fn().mockResolvedValue(opts.latest === undefined ? row : opts.latest),
      findMany: vi.fn().mockResolvedValue([row]),
      count: vi.fn().mockResolvedValue(1),
    },
  };
  const redis = {
    get: vi.fn().mockResolvedValue(opts.snapshot === undefined ? null : opts.snapshot && JSON.stringify(opts.snapshot)),
  };
  const deviceContext = { resolveZoneContext: vi.fn().mockResolvedValue({ zoneId: ZONE }) };
  const contextService = { organizationId: opts.org };
  vi.spyOn(BaremetalRecord, 'findByDeviceIdOrThrow').mockResolvedValue({
    data: { id: DEVICE },
  } as unknown as BaremetalRecord);
  return {
    service: new DeviceHealthChecksService(prisma as never, redis, deviceContext as never, contextService as never),
    prisma,
    redis,
  };
}

describe('DeviceHealthChecksService', () => {
  afterEach(() => vi.restoreAllMocks());

  it('prefers the bridge snapshot for the owner view', async () => {
    const { service, redis } = setup({ org: SUPPLIER, snapshot });
    const out = await service.summary(DEVICE);
    expect(redis.get).toHaveBeenCalledWith(`${ZONE}:device-health:${DEVICE}`);
    expect(out).toMatchObject({
      view: 'owner',
      source: 'snapshot',
      checkedAt: '2026-09-16T11:56:00.000Z',
      isHealthy: true,
      reason: null,
    });
    expect(out.checks?.reachability).toBe('ok');
  });

  it('falls back to the newest row and names the failing probe', async () => {
    const { service } = setup({ org: SUPPLIER });
    const out = await service.summary(DEVICE);
    expect(out).toMatchObject({
      source: 'history',
      checkedAt: '2026-09-16T11:21:00.000Z',
      isHealthy: false,
      reason: 'BMC credentials are invalid',
    });
    expect(out.checks?.reachability).toBe('auth-failed');
  });

  it('reports none with a null isHealthy when nothing is known', async () => {
    const { service } = setup({ org: SUPPLIER, latest: null });
    const out = await service.summary(DEVICE);
    expect(out).toEqual({
      view: 'owner',
      source: 'none',
      checkedAt: null,
      checks: null,
      isHealthy: null,
      reason: null,
      icmpFiltered: false,
    });
  });

  it('nulls every BMC field for the customer view', async () => {
    const { service } = setup({ org: CUSTOMER, device: { supplierId: SUPPLIER }, snapshot });
    const out = await service.summary(DEVICE);
    expect(out.view).toBe('customer');
    expect(out.checks).toEqual({
      primaryReachable: true,
      poweredOn: true,
      bmcIcmpReachable: null,
      bmcIpmiReachable: null,
      bmcRedfishReachable: null,
      bmcCredsValid: null,
      brokkrLiveRunning: null,
      reachability: null,
    });
    expect(out.isHealthy).toBeNull();
    expect(out.reason).toBeNull();
    expect(out.icmpFiltered).toBe(false);
  });

  it('flags icmp as advisory only when another bmc transport answered', async () => {
    const filtered = setup({ org: SUPPLIER, snapshot: { ...snapshot, bmc_icmp_reachable: false } });
    expect((await filtered.service.summary(DEVICE)).icmpFiltered).toBe(true);
    const { service } = setup({ org: SUPPLIER, snapshot });
    expect((await service.summary(DEVICE)).icmpFiltered).toBe(false);
  });

  it('404s a device the caller cannot see and lists rows with reachability', async () => {
    const denied = setup({ org: 'org-other', device: null });
    await expect(denied.service.summary(DEVICE)).rejects.toBeInstanceOf(NotFoundException);
    const { service } = setup({ org: SUPPLIER });
    const page = await service.list(DEVICE, { page: 1 });
    expect(page.retentionDays).toBe(7);
    expect(page.edgeTriggered).toBe(true);
    expect(page.data[0]).toMatchObject({
      id: 'hc-1',
      reachability: 'auth-failed',
      testedAt: '2026-09-16T11:21:00.000Z',
    });
  });
});
