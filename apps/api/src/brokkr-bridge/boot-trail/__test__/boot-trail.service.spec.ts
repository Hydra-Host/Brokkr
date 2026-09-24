import { JobType, LifecycleJobPhase, ServerLifecycleStatus } from '@repo/database';
import { BaremetalRecord } from 'src/devices/baremetal.record';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BootTrailService } from '../boot-trail.service';

const DEVICE = '22222222-2222-2222-2222-222222222222';
const ZONE = '11111111-1111-1111-1111-111111111111';
const MAC = '3c:ec:ef:1a:2b:3c';

type Reply = [Error | null, unknown];

function fakeRedis(replies: Reply[] | Error) {
  const chain = {
    hgetall: () => chain,
    get: () => chain,
    exists: () => chain,
    exec: async () => {
      if (replies instanceof Error) throw replies;
      return replies;
    },
  };
  return { pipeline: () => chain };
}

function setup(opts: {
  replies?: Reply[] | Error;
  interfaces?: Array<{ name: string; macAddress: string | null; mgmtOnly: boolean }>;
  job?: { createdAt: Date } | null;
  lifecycleStatus?: ServerLifecycleStatus;
}) {
  const interfaces = opts.interfaces ?? [
    { name: 'eth0', macAddress: '3C:EC:EF:1A:2B:3C', mgmtOnly: false },
    { name: 'eth1', macAddress: '3c:ec:ef:1a:2b:3d', mgmtOnly: false },
    { name: 'ipmi0', macAddress: '3c:ec:ef:1a:2b:00', mgmtOnly: true },
  ];
  const prisma = {
    interface: { findMany: vi.fn().mockResolvedValue(interfaces) },
    lifecycleJob: { findFirst: vi.fn().mockResolvedValue(opts.job ?? null) },
  };
  const deviceContext = { resolveZoneContext: vi.fn().mockResolvedValue({ zoneId: ZONE }) };
  vi.spyOn(BaremetalRecord, 'findByDeviceIdOrThrow').mockResolvedValue({
    data: {
      id: DEVICE,
      name: 'gpu-node-07',
      server: {
        lifecycleStatus: opts.lifecycleStatus ?? ServerLifecycleStatus.INVENTORY,
        updatedAt: new Date('2026-09-16T11:00:00.000Z'),
      },
    },
  } as unknown as BaremetalRecord);
  const redis = fakeRedis(
    opts.replies ?? [
      [null, {}],
      [null, null],
      [null, 0],
    ],
  );
  const service = new BootTrailService(redis, prisma as never, deviceContext as never);
  return { service, prisma, deviceContext };
}

describe('BootTrailService.read', () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date('2026-09-16T12:00:00.000Z') }));
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reads the three markers by exact key and reports an offered request with a chain hit', async () => {
    const { service } = setup({
      replies: [
        [null, { outcome: 'offered', at: '1789560131000' }],
        [null, JSON.stringify({ atMs: 1789560139000, deviceId: DEVICE })],
        [null, 0],
      ],
    });
    const out = await service.read(DEVICE);
    expect(out.pxeMac).toBe(MAC);
    expect(out.candidateMacs).toEqual(['3c:ec:ef:1a:2b:3d']);
    expect(out.zoneId).toBe(ZONE);
    expect(out.trail).toEqual({
      pxe: { outcome: 'offered', atMs: 1789560131000 },
      chainReached: true,
      chainAtMs: 1789560139000,
      chainDeviceMismatch: false,
      readError: null,
    });
  });

  it('reports absent markers as null, not false', async () => {
    const { service } = setup({});
    const out = await service.read(DEVICE);
    expect(out.trail).toEqual({
      pxe: null,
      chainReached: false,
      chainAtMs: null,
      chainDeviceMismatch: false,
      readError: null,
    });
  });

  it('reports a redis failure as readError with unknown booleans', async () => {
    const { service } = setup({ replies: new Error('ECONNREFUSED') });
    const out = await service.read(DEVICE);
    expect(out.trail.readError).toContain('ECONNREFUSED');
    expect(out.trail.pxe).toBeNull();
    expect(out.trail.chainReached).toBeNull();
  });

  it('reports a device with no data mac as unreadable', async () => {
    const { service } = setup({
      interfaces: [{ name: 'ipmi0', macAddress: '3c:ec:ef:1a:2b:00', mgmtOnly: true }],
    });
    const out = await service.read(DEVICE);
    expect(out.pxeMac).toBeNull();
    expect(out.trail.readError).toBe('no data interface with a MAC');
  });

  it('flags a chain hit that names another device', async () => {
    const { service } = setup({
      replies: [
        [null, {}],
        [null, JSON.stringify({ atMs: 1789560139000, deviceId: 'other' })],
        [null, 0],
      ],
    });
    const out = await service.read(DEVICE);
    expect(out.trail.chainDeviceMismatch).toBe(true);
    expect(out.trail.chainReached).toBe(true);
  });

  it('derives bootExpected from the provisioning status when no network-boot job is open', async () => {
    const { service } = setup({ lifecycleStatus: ServerLifecycleStatus.PROVISIONING });
    const out = await service.read(DEVICE);
    expect(out.bootExpected).toEqual({
      expected: true,
      since: '2026-09-16T11:00:00.000Z',
      reason: 'provisioning-status',
    });
  });

  it('derives bootExpected from the newest network-boot job', async () => {
    const { service, prisma } = setup({ job: { createdAt: new Date('2026-09-16T11:50:00.000Z') } });
    const out = await service.read(DEVICE);
    expect(out.bootExpected).toEqual({ expected: true, since: '2026-09-16T11:50:00.000Z', reason: 'active-job' });
    expect(prisma.lifecycleJob.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          deviceId: DEVICE,
          jobType: { in: [JobType.Provision, JobType.Reprovision, JobType.Deprovision] },
          phase: { notIn: [LifecycleJobPhase.COMPLETED, LifecycleJobPhase.FAILED, LifecycleJobPhase.ABORTED] },
        }),
      }),
    );
  });
});
